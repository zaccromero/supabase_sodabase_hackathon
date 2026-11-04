/** Local PostgreSQL-compatible integration using synthetic test fixtures, not demo data. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createEvaluator, frozenChecksHash} from '../../src/evaluators/adapter.js';
import {evaluateStoredOutput} from '../../src/evaluators/storage.js';
import {sha256} from '../../src/contract/hash.js';
import type {CheckSpec, EvaluationBinding} from '../../src/contract/types.js';

test('evaluator receipt passes real local gate; repair invalidates earlier pass; worker cannot self-pass',async()=>{
 const db=new PGlite();
 try {
  await db.exec(await readFile(new URL('../../supabase/migrations/001_core.sql',import.meta.url),'utf8'));
  const one=async(sql:string,args:unknown[]=[]) => (await db.query<Record<string,unknown>>(sql,args)).rows[0];
  const run=String((await one("insert into cm.runs(profile,task) values ('milo_pitch','SYNTHETIC INTEGRATION FIXTURE') returning id")).id);
  const checks:CheckSpec[]=[{check_id:'receipt',kind:'deterministic',required:true,requires_evidence:true,spec:{type:'required_steps',steps:[{id:'source',evidenceKind:'source'}]}}];
  const hash=frozenChecksHash(checks);
  const contract=String((await one('insert into cm.check_contracts(run_id) values ($1) returning id',[run])).id);
  await db.query('insert into cm.contract_checks(contract_id,check_id,kind,required,requires_evidence,spec) values ($1,$2,$3,$4,$5,$6)',[contract,checks[0].check_id,checks[0].kind,true,true,JSON.stringify(checks[0].spec)]);
  await db.query('update cm.check_contracts set frozen_at=now(),contract_sha256=$2 where id=$1',[contract,hash]);
  const attempt=String((await one("insert into cm.attempts(run_id,contract_id,attempt_no,kind) values ($1,$2,0,'initial') returning id",[run,contract])).id);
  const body={after:'Synthetic fixture'};
  const output=String((await one('insert into cm.outputs(attempt_id,body,output_sha256) values ($1,$2,$3) returning id',[attempt,JSON.stringify(body),sha256(body)])).id);
  const source=String((await one("insert into cm.evidence(output_id,kind,payload,created_by) values ($1,'source','{\"test_fixture\":true}','agent_worker') returning id",[output])).id);
  const binding:EvaluationBinding={run_id:run,attempt_id:attempt,output_id:output,contract_id:contract,output_sha256:sha256(body),contract_sha256:hash};
  await db.exec('set role gate_service');
  assert.equal((await one('select cm.request_completion($1) result',[run])).result && ((await one('select cm.gate_missing($1) missing',[run])).missing as unknown[]).length,1);
  await db.exec('reset role');
  const evaluator=createEvaluator({evaluatorId:'evaluator_service',loadContext:async()=>({frozenAt:'2026-11-04T21:00:00Z',checks,editingAgentId:'agent_worker',evidence:[{id:source,binding,kind:'source',text:'Synthetic SQL fixture receipt'}]})});
  const result=await evaluator({binding,check:checks[0],output:body,decisions:[]});
  assert.equal(result.verdict,'pass');
  await db.exec('set role evaluator_service');
  const stored=await evaluateStoredOutput(db,binding,'receipt',{evaluatorId:'independent',editingAgentId:'agent_worker'});
  assert.equal(stored.result.verdict,'pass');
  assert.ok(stored.evaluationId);
  await assert.rejects(evaluateStoredOutput(db,{...binding,output_sha256:'wrong'},'receipt',{evaluatorId:'independent',editingAgentId:'agent_worker'}),/binding mismatch/);
  const receipt=String((await one('insert into cm.evidence(output_id,kind,payload,created_by) values ($1,$2,$3,$4) returning id',[output,result.evidence!.kind,JSON.stringify(result.evidence!.payload),'evaluator_service'])).id);
  const insert='insert into cm.evaluations(run_id,attempt_id,output_id,contract_id,check_id,output_sha256,contract_sha256,evaluator,evaluator_version,verdict,reason,evidence_id) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)';
  const args=[run,attempt,output,contract,result.check_id,binding.output_sha256,hash,result.evaluator,result.evaluator_version,result.verdict,result.reason,receipt];
  await db.query(insert,args);
  await assert.rejects(db.query(insert,[...args.slice(0,5),'stale-hash',...args.slice(6)]),/BINDING_OUTPUT_HASH_MISMATCH/);
  await db.exec('set role agent_worker');
  await assert.rejects(db.query(insert,args),/permission denied/);
  await db.exec('set role gate_service');
  assert.equal(((await one('select cm.request_completion($1) result',[run])).result as {verdict:string}).verdict,'completed');
  // Separate pending run demonstrates repair invalidation without reopening a completed run.
  await db.exec('reset role');
  const second=String((await one("insert into cm.runs(profile,task) values ('milo_pitch','SYNTHETIC REPAIR FIXTURE') returning id")).id);
  const c2=String((await one('insert into cm.check_contracts(run_id) values ($1) returning id',[second])).id);
  await db.query("insert into cm.contract_checks(contract_id,check_id,kind) values ($1,'receipt','deterministic')",[c2]);
  await db.query('update cm.check_contracts set frozen_at=now(),contract_sha256=$2 where id=$1',[c2,hash]);
  const initial2=String((await one("insert into cm.attempts(run_id,contract_id,attempt_no,kind) values ($1,$2,0,'initial') returning id",[second,c2])).id);
  const output2=String((await one('insert into cm.outputs(attempt_id,body,output_sha256) values ($1,$2,$3) returning id',[initial2,JSON.stringify(body),sha256(body)])).id);
  const evidence2=String((await one("insert into cm.evidence(output_id,kind,payload,created_by) values ($1,'test_receipt','{}','evaluator_service') returning id",[output2])).id);
  await db.query(insert,[second,initial2,output2,c2,'receipt',sha256(body),hash,'evaluator_service','1','pass','Synthetic prior pass',evidence2]);
  assert.deepEqual((await one('select cm.gate_missing($1) missing',[second])).missing,[]);
  const repair=String((await one("insert into cm.attempts(run_id,contract_id,attempt_no,kind) values ($1,$2,1,'repair') returning id",[second,c2])).id);
  await db.query('insert into cm.outputs(attempt_id,body,output_sha256) values ($1,$2,$3)',[repair,JSON.stringify(body),sha256(body)]);
  const missing=(await one('select cm.gate_missing($1) missing',[second])).missing as Array<{reason:string}>;
  assert.equal(missing[0].reason,'NO_CURRENT_EVALUATION');
 } finally { await db.close(); }
});
