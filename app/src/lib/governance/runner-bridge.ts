/** Read-only bridge for the actual runner DB API; independent of evaluator implementation exports. */
import { sha256 } from './hash';
export interface ProviderEvidence {
  provider: 'sodabase'; tool: 'data_trust' | 'data_trust_health' | 'check_rule'; target: string; observed_at: string;
  provider_checked_at: string | null; state: 'received' | 'pending' | 'unknown' | 'blocked' | 'error';
  verdict: 'trusted' | 'caveated' | 'untrusted' | 'unknown' | 'scanning'; reason: string; raw: unknown | null;
}
export interface ReaderDb {
  withRole<T>(role: 'dashboard_reader', fn: (tx: {query<R = Record<string, any>>(sql: string, params?: unknown[]): Promise<R[]>}) => Promise<T>): Promise<T>;
}
export interface TrustPorts {
  dataTrust?: (table: string) => Promise<ProviderEvidence>;
  checkRule?: (dataset: string, rule: string) => Promise<ProviderEvidence>;
  /** Trusted integration configuration; never a worker-supplied request property. */
  sameDatasetSnapshot?: boolean;
}
const dependencies = {
  milo_pitch: {tables:['cm.sources','cm.decisions'],keys:['milo.gym_nyc_partner','milo.fee_not_collected','milo.alpha_not_usage','milo.current_positioning']},
  gym_operator: {tables:['cm.sources','cm.decisions','gym.ezf_active_memberships','gym.ezf_active_membership_sync_runs','gym.locations'],keys:['gym.active_individual_definition','gym.freshness_completeness']},
};
async function load(db: ReaderDb, runId: string) {
  return db.withRole('dashboard_reader', async tx => {
    const [run] = await tx.query(`select r.id run_id,r.profile,r.memory_mode,r.status,a.id attempt_id,a.attempt_no,o.id output_id,o.body,o.output_sha256,c.id contract_id,c.contract_sha256,c.frozen_at
      from cm.runs r left join cm.attempts a on a.id=(select id from cm.attempts where run_id=r.id order by attempt_no desc limit 1)
      left join cm.outputs o on o.attempt_id=a.id left join cm.check_contracts c on c.run_id=r.id where r.id=$1::uuid`,[runId]);
    if (!run) throw Error('Run not found');
    const checks = await tx.query('select check_id,kind,required,requires_evidence,decision_id,spec from cm.contract_checks where contract_id=$1::uuid order by check_id',[run.contract_id]);
    const decisions = await tx.query(`select d.id,d.decision_key,d.version,d.statement,d.status,d.accepted_by,d.accepted_at,d.source_id,s.content_sha256,s.historical from cm.run_decisions rd join cm.decisions d on d.id=rd.decision_id join cm.sources s on s.id=d.source_id where rd.run_id=$1::uuid`,[runId]);
    const evaluations = await tx.query(`select e.*,v.output_id evidence_output_id,v.kind evidence_kind,v.created_by evidence_created_by,v.payload evidence_payload
      from cm.evaluations e left join cm.evidence v on v.id=e.evidence_id where e.run_id=$1::uuid and e.attempt_id=$2::uuid order by e.created_at desc,e.id desc`,[runId,run.attempt_id]);
    const [gate] = await tx.query('select verdict,missing,attempt_id from cm.gate_decisions where run_id=$1::uuid order by created_at desc,id desc limit 1',[runId]);
    return {run,checks,decisions,evaluations,gate:gate??null};
  });
}
/** Reads real runner records and actual provider findings. Never invokes a handler, model, evaluator or gate. */
export async function assessRunnerRun(db: ReaderDb, runId: string, ports: TrustPorts = {}) {
  const snapshot = await load(db,runId);
  const {run,checks,decisions,evaluations,gate} = snapshot;
  const policy = dependencies[run.profile as keyof typeof dependencies];
  const reasons: string[] = [];
  let hold = false, needsFounder = false;
  const block = (reason:string) => {hold=true;reasons.push(reason);};
  if (!policy) block('Unsupported run profile.');
  if (run.memory_mode !== 'on') block('Baseline run is not fresh accepted-memory verification.');
  if (!run.output_id || !run.body || sha256(run.body)!==run.output_sha256) block('Latest output missing or hash mismatch.');
  if (!run.frozen_at || !checks.some(c=>c.required) || sha256(checks)!==run.contract_sha256) block('Frozen contract missing or canonical hash mismatch.');
  if (policy?.keys.some(key=>decisions.filter(d=>d.decision_key===key && d.status==='accepted' && d.accepted_by && d.accepted_at).length!==1)) block('Required accepted decision version/provenance not pinned.');
  const current = checks.filter(c=>c.required).map(check=>{
    const e=evaluations.find(e=>e.check_id===check.check_id);
    const bound=!!e && e.output_id===run.output_id && e.contract_id===run.contract_id && e.output_sha256===run.output_sha256 && e.contract_sha256===run.contract_sha256;
    const evidence=!!e?.evidence_id && e.evidence_output_id===run.output_id && e.evidence_created_by!=='agent_worker' && e.evidence_created_by===e.evaluator && e.evaluator!=='agent_worker';
    if(!bound || (check.requires_evidence && !evidence)) block(`No current independent bound evidence for ${check.check_id}.`);
    if(e?.verdict==='fail') block(`Evaluation failed: ${check.check_id}.`);
    if(e?.verdict==='uncertain') {needsFounder=true;reasons.push(`Founder required: ${check.check_id}.`);}
    if(e && !['pass','fail','uncertain'].includes(e.verdict)) block(`Invalid evaluation verdict: ${check.check_id}.`);
    return {check_id:check.check_id,kind:check.kind,evaluation_id:e?.id??null,verdict:bound ? e.verdict : 'unknown',bound,evidence,evidence_id:e?.evidence_id??null,evidence_payload:e?.evidence_payload??null};
  });
  if (!current.some(e=>e.kind==='critic')) block('Required independent meaning critic missing from contract.');
  const trust: ProviderEvidence[]=[];
  for(const table of policy?.tables??[]) {
    try {
      if(!ports.dataTrust) throw Error('Missing provider');
      const finding=await ports.dataTrust(table);
      if(finding.target!==table || finding.provider!=='sodabase' || !['data_trust','data_trust_health'].includes(finding.tool)) throw Error('Provider target mismatch');
      trust.push(finding);
    } catch { block(`Trust unavailable for ${table}.`); }
  }
  if(trust.some(t=>t.state!=='received' || !['trusted','caveated'].includes(t.verdict))) block('Required data trust is unknown, pending, untrusted or failed.');
  let rule: ProviderEvidence|null=null;
  if(ports.checkRule) {
    try {rule=await ports.checkRule('cm.decisions','Every accepted decision has accepted_by, accepted_at and source_id; decision_key and version are unique.');
      if(rule.target!=='cm.decisions' || rule.tool!=='check_rule' || rule.state!=='received') block('Rule retrieval unavailable or mismatched.');
    } catch {block('Rule retrieval failed.');}
  } else block('Non-persistent provenance rule findings unavailable.');
  if(!ports.sameDatasetSnapshot) block('Provider findings not bound to retrieved event dataset/snapshot.');
  if(!gate || gate.attempt_id!==run.attempt_id || gate.verdict!=='completed' || run.status!=='completed') block('Actual latest-attempt database completion gate is not completed.');
  // Network observations may outlive the latest attempt: reject any intervening mutation.
  const after = await load(db,runId);
  if(after.run.attempt_id!==run.attempt_id || after.run.output_sha256!==run.output_sha256 || after.run.contract_sha256!==run.contract_sha256 || after.run.status!==run.status || sha256(after.decisions)!==sha256(decisions)) block('Run or accepted memory changed while provider findings were obtained.');
  const recommendation=hold?'hold':needsFounder?'needs_founder':trust.some(t=>t.verdict==='caveated')?'caveated':'proceed';
  return {schema:'runner-governance/v1',observedAt:new Date().toISOString(),runId,attemptId:run.attempt_id,outputId:run.output_id,outputSha256:run.output_sha256,contractSha256:run.contract_sha256,
    profile:run.profile,dependencies:policy??null,pinnedDecisions:decisions,evaluations:current,trust,rule,gate,recommendation,reasons,
    authority:'read_only_advisory',completionGate:'READ_EXISTING_ONLY',proof:'Stored runner/evaluator records; provider findings labeled separately; no model execution performed by bridge.'};
}
