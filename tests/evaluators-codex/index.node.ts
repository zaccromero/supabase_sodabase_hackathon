// Explicit synthetic fixtures for unit tests only; never demo evidence.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {evaluate, canComplete} from '../../src/evaluators/core.js';
import type {EvaluationInput, Check} from '../../src/evaluators/core.js';
const step: Check = {id:'steps',kind:'required_steps',required:true,steps:[{id:'query',evidenceKind:'query_receipt'}]};
function fixture(check: Check = step): EvaluationInput {
 const binding = {runId:'test-run',attempt:0,outputRevision:'sha-test',contractId:'test-contract',contractRevision:'1'};
 return {binding,output:'Gym NYC is a partner',editingAgentId:'worker',evaluatorId:'independent-evaluator',
 contract:{id:'test-contract',revision:'1',frozenAt:'2026-11-04T21:00:00Z',checks:[check]},pinnedDecisions:[{id:'d',version:1,status:'accepted',statement:'Gym NYC is a partner'}],
 evidence:[{...binding,id:'test-evidence',kind:'query_receipt',text:'Synthetic test receipt'}]};
}
test('current required evidence passes',async()=>assert.equal((await evaluate(fixture(),step)).verdict,'pass'));
for (const [key,value] of Object.entries({runId:'old',attempt:1,outputRevision:'old',contractId:'old',contractRevision:'old'})) {
 test(`rejects stale evidence ${key}`,async()=> {const i=fixture(); Object.assign(i.evidence[0],{[key]:value});assert.equal((await evaluate(i,step)).verdict,'fail');});
}
test('editing agent cannot self-pass',async()=>{const i=fixture();i.evaluatorId=i.editingAgentId;assert.equal((await evaluate(i,step)).verdict,'fail');});
test('unfrozen or substituted contract fails',async()=>{const i=fixture();i.contract.frozenAt='';assert.equal((await evaluate(i,step)).verdict,'fail');assert.equal((await evaluate(fixture(),{...step,steps:[]})).verdict,'fail');});
const decision: Check={id:'decision',kind:'decision',required:true,decisionId:'d',decisionVersion:1,requiredPhrases:['partner'],forbiddenPhrases:["founder's own gym"]};
test('explicit decision compliance and violations',async()=>{const i=fixture(decision);assert.equal((await evaluate(i,decision)).verdict,'pass');i.output="founder's own gym";assert.equal((await evaluate(i,decision)).verdict,'fail');i.output='Gym NYC';assert.equal((await evaluate(i,decision)).verdict,'fail');});
test('unpinned decision cannot pass',async()=>{const i=fixture(decision);i.pinnedDecisions[0].version=2;assert.equal((await evaluate(i,decision)).verdict,'fail');});
const critic: Check={id:'critic',kind:'critic',required:true,criterion:'Check partner positioning using supplied evidence'};
test('critic unavailable, malformed, throwing, uncited or stale responses are uncertain',async()=>{
 const i=fixture(critic);
 assert.equal((await evaluate(i,critic)).verdict,'uncertain');
 for(const response of [null,{verdict:'pass',reason:'ok',evidenceRefs:[]},{verdict:'pass',reason:'ok',evidenceRefs:['not-current']},{verdict:'approved',reason:'ok',evidenceRefs:['test-evidence']}])
 assert.equal((await evaluate(i,critic,async()=>response)).verdict,'uncertain');
 assert.equal((await evaluate(i,critic,async()=>{throw Error('test');})).verdict,'uncertain');
});
test('critic gets only current evidence and returns supported verdict',async()=>{const i=fixture(critic);i.evidence.push({...i.evidence[0],id:'stale',attempt:9});const r=await evaluate(i,critic,async req=>{assert.deepEqual(req.evidence.map(e=>e.id),['test-evidence']);return {verdict:'pass',reason:'Supported',evidenceRefs:['test-evidence']};});assert.equal(r.verdict,'pass');assert.equal(canComplete(i,[r]),true);});
test('completion rejects stale, missing and later failing verdicts',async()=>{const i=fixture();const r=await evaluate(i,step);assert.equal(canComplete(i,[]),false);assert.equal(canComplete(i,[{...r,attempt:1}]),false);assert.equal(canComplete(i,[r,{...r,verdict:'fail'}]),false);assert.equal(canComplete(i,[r]),true);});
test('duplicate evidence IDs fail closed',async()=>{const i=fixture();i.evidence.push(i.evidence[0]);assert.equal((await evaluate(i,step)).verdict,'fail');});

test('critic caller mutation cannot change verdict binding',async()=>{const i=fixture(critic);const r=await evaluate(i,critic,async()=>{i.binding.outputRevision='mutated';return {verdict:'pass',reason:'Supported',evidenceRefs:['test-evidence']};});assert.equal(r.outputRevision,'sha-test');});
