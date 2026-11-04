import type {CheckSpec, EvaluationBinding, Evaluator, PinnedDecision, EvaluationResult} from '../contract/types.js';
import {canonicalJson} from '../contract/hash.js';
import {createEvaluator} from './adapter.js';
import type {ModelCritic} from './core.js';
/** A dedicated transaction-capable connection, already authenticated as evaluator_service. */
export interface EvaluatorDatabase {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql:string, params?:unknown[]):Promise<{rows:T[]}>;
}
export interface StoredEvaluationOptions { evaluatorId: string; editingAgentId: string; critic?:ModelCritic; registry?:Record<string,Evaluator>; }
/** Reads authoritative records and persists one bound receipt + verdict atomically. Never changes run state. */
export async function evaluateStoredOutput(db:EvaluatorDatabase, expected:EvaluationBinding, checkId:string, options:StoredEvaluationOptions):Promise<{evaluationId:string;result:EvaluationResult}> {
  await db.query('begin');
  try {
    const role=await db.query('select current_user as role');
    if(role.rows[0]?.role !== 'evaluator_service') throw new Error('Evaluator connection must use evaluator_service role');
    const found=await db.query(`select a.run_id,a.id attempt_id,o.id output_id,c.id contract_id,o.output_sha256,c.contract_sha256,c.frozen_at,o.body
      from cm.outputs o join cm.attempts a on a.id=o.attempt_id join cm.check_contracts c on c.id=a.contract_id
      where o.id=$1 and a.run_id=$2`,[expected.output_id,expected.run_id]);
    const row=found.rows[0];
    if(!row) throw new Error('Bound output not found');
    const actual:EvaluationBinding={run_id:String(row.run_id),attempt_id:String(row.attempt_id),output_id:String(row.output_id),contract_id:String(row.contract_id),output_sha256:String(row.output_sha256),contract_sha256:String(row.contract_sha256)};
    if(canonicalJson(actual)!==canonicalJson(expected)) throw new Error('Stored evaluation binding mismatch');
    const checksResult=await db.query(`select check_id,kind,required,requires_evidence,decision_id,spec from cm.contract_checks where contract_id=$1 order by check_id`,[expected.contract_id]);
    // Omit null optional keys so the canonical hash matches CheckSpec used during freeze.
    const checks:CheckSpec[]=checksResult.rows.map(r=>({check_id:String(r.check_id),kind:r.kind as CheckSpec['kind'],required:Boolean(r.required),requires_evidence:Boolean(r.requires_evidence),...(r.decision_id?{decision_id:String(r.decision_id)}:{}),spec:r.spec as Record<string,unknown>}));
    const check=checks.find(c=>c.check_id===checkId);
    if(!check) throw new Error('Frozen check not found');
    const decisionsResult=await db.query(`select d.id,d.decision_key,d.version,d.statement,s.uri source_uri,s.historical source_historical
      from cm.run_decisions rd join cm.decisions d on d.id=rd.decision_id join cm.sources s on s.id=d.source_id
      where rd.run_id=$1 and d.accepted_by is not null and d.accepted_at is not null order by d.id`,[expected.run_id]);
    const decisions=decisionsResult.rows as unknown as PinnedDecision[];
    const evidenceResult=await db.query(`select id,kind,payload,uri,created_by from cm.evidence where output_id=$1 and kind <> 'behavioral_evaluation' order by created_at,id`,[expected.output_id]);
    const context={frozenAt:row.frozen_at instanceof Date?row.frozen_at.toISOString():String(row.frozen_at ?? ''),checks,editingAgentId:options.editingAgentId,
      evidence:evidenceResult.rows.map(e=>({id:String(e.id),binding:actual,kind:String(e.kind),text:canonicalJson({payload:e.payload,uri:e.uri,created_by:e.created_by})}))};
    const evaluator=options.registry?.[check.check_id] ?? createEvaluator({evaluatorId:options.evaluatorId,loadContext:async()=>context,critic:options.critic});
    const result=await evaluator({binding:actual,check,output:row.body as Record<string,unknown>,decisions});
    if(!result.evidence) throw new Error('Evaluation receipt missing');
    const evidence=await db.query(`insert into cm.evidence(output_id,kind,payload,created_by) values ($1,$2,$3,$4) returning id`,[actual.output_id,result.evidence.kind,JSON.stringify(result.evidence.payload),options.evaluatorId]);
    const inserted=await db.query(`insert into cm.evaluations(run_id,attempt_id,output_id,contract_id,check_id,output_sha256,contract_sha256,evaluator,evaluator_version,verdict,reason,evidence_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,[actual.run_id,actual.attempt_id,actual.output_id,actual.contract_id,result.check_id,actual.output_sha256,actual.contract_sha256,result.evaluator,result.evaluator_version,result.verdict,result.reason,evidence.rows[0].id]);
    await db.query('commit');
    return {evaluationId:String(inserted.rows[0].id),result};
  } catch(error) {
    await db.query('rollback');
    throw error;
  }
}
