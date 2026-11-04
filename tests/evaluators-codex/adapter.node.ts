import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createEvaluator, frozenChecksHash} from '../../src/evaluators/adapter.js';
import {sha256} from '../../src/contract/hash.js';
import type {CheckSpec, EvaluationBinding} from '../../src/contract/types.js';
const checks:CheckSpec[]=[{check_id:'partner',kind:'deterministic',required:true,requires_evidence:true,decision_id:'d',spec:{type:'decision',decision_version:1,required_phrases:['partner'],forbidden_phrases:["founder's own gym"]}}];
const output={after:'Gym NYC is a partner'};
const binding:EvaluationBinding={run_id:'r',attempt_id:'a',output_id:'o',contract_id:'c',output_sha256:sha256(output),contract_sha256:frozenChecksHash(checks)};
const input={binding,check:checks[0],output,decisions:[{id:'d',decision_key:'partner',version:1,statement:'Partner',source_uri:'test://fixture',source_historical:false}]};
function evaluator(stale=false){return createEvaluator({evaluatorId:'independent',loadContext:async()=>({frozenAt:'2026-11-04T21:00:00Z',checks,editingAgentId:'worker',evidence:[{id:'e',binding:{...binding,attempt_id:stale?'old':'a'},kind:'source',text:'Synthetic fixture'}]})});}
test('shared adapter emits bound receipt',async()=>{const r=await evaluator()(input);assert.equal(r.verdict,'pass');assert.deepEqual(r.evidence?.payload.binding,binding);});
test('shared adapter rejects stale attempt evidence',async()=>assert.equal((await evaluator(true)(input)).verdict,'fail'));
test('shared adapter rejects changed output hash',async()=>assert.equal((await evaluator()({...input,output:{after:'changed'}})).verdict,'fail'));
test('shared adapter rejects changed frozen checks hash',async()=>assert.equal((await evaluator()({...input,binding:{...binding,contract_sha256:'wrong'}})).verdict,'fail'));

test('frozen output_path checks revised text without rejecting historical before',async()=>{
 const selected={...checks[0],spec:{...checks[0].spec,output_path:['after']}};
 const body={before:"the founder's own gym",after:'Gym NYC is a partner'};
 const b={...binding,output_sha256:sha256(body),contract_sha256:frozenChecksHash([selected])};
 const ev=createEvaluator({evaluatorId:'independent',loadContext:async()=>({frozenAt:'2026-11-04T21:00:00Z',checks:[selected],editingAgentId:'worker',evidence:[{id:'e',binding:b,kind:'source',text:'Synthetic fixture'}]})});
 assert.equal((await ev({...input,binding:b,check:selected,output:body})).verdict,'pass');
});
