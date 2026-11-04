import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createModelCritic} from '../../src/evaluators/critic.js';
import type {CriticRequest} from '../../src/evaluators/core.js';
const request: CriticRequest = {
 binding:{runId:'test',attempt:0,outputRevision:'test',contractId:'test',contractRevision:'1'},
 check:{id:'test',kind:'critic',required:true,criterion:'Test only'},output:'Synthetic fixture',decisions:[],evidence:[],instruction:'System instruction'
};
test('critic transport parses strict JSON and separates instructions from output',async()=>{
 const critic=createModelCritic({complete:async r=>{assert.equal(r.system,'System instruction');assert.equal(JSON.parse(r.user).output,'Synthetic fixture');return '{"verdict":"uncertain","reason":"No evidence","evidenceRefs":[]}';}});
 assert.deepEqual(await critic(request),{verdict:'uncertain',reason:'No evidence',evidenceRefs:[]});
});
test('critic times out even when transport ignores abort',async()=>{
 const critic=createModelCritic({complete:async()=>new Promise<string>(()=>{})},5);
 await assert.rejects(critic(request),/Critic timeout/);
});
test('critic rejects non-JSON response',async()=>{
 await assert.rejects(createModelCritic({complete:async()=> 'not json'})(request));
});
