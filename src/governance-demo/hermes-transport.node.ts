/** Synthetic transport-envelope tests; no model/provider call. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesRequest,hermesModelClient,withHermesGeneration,withHermesCritic,type HermesReply } from './hermes-transport.ts';
import {sha256} from '../contract/hash.ts';
const payload={system:'Synthetic test',user:'Synthetic data'};
const fixture=():HermesReply=>({ok:true,text:'{"after":"Synthetic candidate"}',receipt:{state:'RECEIVED',provider:'openai-codex',served_model:'fixture-model',model_provider:'openai',model_turns:1,tool_iterations:0,guard_bypass:false,credential_exported:false,isolation:{use_memories:false,generate_memories:false,thread_memory_mode:'disabled'},no_tools_scope:{tool_policy:'none',max_authorized_actions:0},thread_id:'synthetic',turn_id:'synthetic',token_usage:{inputTokens:7,outputTokens:3}}});
test('accepts only successful scoped Hermes envelope, preserves actual reported model/tokens',async()=>{
 const model=hermesModelClient({run:async()=>fixture()});
 const r=await model.create({system:'S',messages:[{role:'user',content:'U'}]});
 assert.equal(model.transport,'hermes_oauth');assert.equal(r.model,'fixture-model');assert.equal(r.usage.input_tokens,7);
});
test('rejects bypass, memory, tool action, and missing served model',async()=>{
 for(const mutate of [(r:HermesReply)=>{r.receipt.guard_bypass=true;},(r:HermesReply)=>{r.receipt.isolation!.use_memories=true;},(r:HermesReply)=>{r.receipt.tool_iterations=1;},(r:HermesReply)=>{r.receipt.served_model=undefined;},(r:HermesReply)=>{r.receipt.no_tools_scope=undefined;}]){
  const r=fixture();mutate(r);await assert.rejects(createHermesRequest({run:async()=>r})(payload));
 }
});
test('failed transport has no fallback or implicit retry',async()=>{
 let calls=0;await assert.rejects(createHermesRequest({run:async()=>{calls++;return {...fixture(),ok:false};}})(payload));assert.equal(calls,1);
});
test('generation wrapper binds actual receipt into handler evidence',async()=>{
 const handler=withHermesGeneration(client=>async()=>{await client.create({system:'S',messages:[]});return {body:{after:'synthetic'},evidence:[]};},{run:async()=>fixture()});
 const result=await handler({runId:'synthetic',attemptNo:1,task:'synthetic',decisions:[]});
 assert.equal(result.evidence[0].kind,'hermes_transport');assert.equal(result.evidence[0].sha256,sha256(result.evidence[0].payload));assert.equal(result.evidence[0].payload.purpose,'generation');
});
test('authored handler output cannot pretend to be a Hermes generation',async()=>{
 const handler=withHermesGeneration(()=>async()=>({body:{after:'authored'},evidence:[]}));
 await assert.rejects(handler({runId:'synthetic',attemptNo:1,task:'synthetic',decisions:[]}));
});
test('critic preserves semantic judgment and adds bound runtime proof without Anthropic-model label',async()=>{
 const evaluator=withHermesCritic(transport=>async input=>{await transport.complete({...payload,signal:new AbortController().signal});return {check_id:input.check.check_id,verdict:'pass',reason:'Synthetic judgment',evaluator:'critic',evaluator_version:'test',evidence:{kind:'old',payload:{model:'old-anthropic-label'}}};},{run:async()=>fixture()});
 const result=await evaluator({binding:{run_id:'r',attempt_id:'a',output_id:'o',contract_id:'c',output_sha256:'h',contract_sha256:'ch'},check:{check_id:'meaning',kind:'critic',required:true,requires_evidence:true,spec:{}},output:{},decisions:[]});
 assert.equal(result.verdict,'pass');assert.equal(result.evidence!.kind,'hermes_critic_evaluation');assert.equal(result.evidence!.payload.model,'fixture-model');assert.equal(result.evidence!.sha256,sha256(result.evidence!.payload));
});
test('critic pass without an actual transport receipt is downgraded to uncertainty',async()=>{
 const evaluator=withHermesCritic(()=>async input=>({check_id:input.check.check_id,verdict:'pass',reason:'No call',evaluator:'synthetic',evaluator_version:'1'}));
 const r=await evaluator({binding:{run_id:'r',attempt_id:'a',output_id:'o',contract_id:'c',output_sha256:'h',contract_sha256:'ch'},check:{check_id:'meaning',kind:'critic',required:true,requires_evidence:true,spec:{}},output:{},decisions:[]});assert.equal(r.verdict,'uncertain');
});
test('legacy ModelTrace request label is replaced by the actual Hermes route metadata',async()=>{
 const value=fixture();value.receipt.requested_model='actual-requested-model';
 const handler=withHermesGeneration(client=>async()=>{await client.create({messages:[]});return {body:{},evidence:[{kind:'model_run',payload:{requested_model:'legacy-vendor-label'}}]};},{run:async()=>value});
 const r=await handler({runId:'r',attemptNo:1,task:'synthetic',decisions:[]});
 assert.equal(r.evidence[0].payload.requested_model,'actual-requested-model');assert.equal(r.evidence[0].payload.declared_agent_model,'legacy-vendor-label');assert.equal(r.evidence[0].sha256,sha256(r.evidence[0].payload));
});
test('application tool JSON becomes a tool_use block without native tool execution',async()=>{
 const value=fixture();value.text=JSON.stringify({text:'',calls:[{name:'run_sql',input:{sql:'select count(*) from gym.members'}}]});
 const model=hermesModelClient({run:async()=>value});
 const r=await model.create({messages:[],tools:[{name:'run_sql',description:'synthetic',input_schema:{type:'object',properties:{sql:{type:'string'}},required:['sql'],additionalProperties:false}}]});
 assert.equal(r.stop_reason,'tool_use');assert.equal(r.content[0].type,'tool_use');assert.equal(value.receipt.tool_iterations,0);
});
test('unknown tools, missing required input, and extra tool properties are rejected',async()=>{
 for(const call of [{name:'terminal',input:{}},{name:'run_sql',input:{}},{name:'run_sql',input:{sql:'select 1',extra:'x'}}]) {
  const value=fixture();value.text=JSON.stringify({text:'',calls:[call]});const model=hermesModelClient({run:async()=>value});
  await assert.rejects(model.create({messages:[],tools:[{name:'run_sql',input_schema:{type:'object',properties:{sql:{type:'string'}},required:['sql'],additionalProperties:false}}]}));
 }
});
test('actual published Gym handler retains its application reader loop and evidence',async()=>{
 const {createGymOperator}=await import('/Users/zaccromero/code/hackathon/supabase_sodabase_hackathon/src/agents/gymOperator.ts');
 let modelCalls=0,reads=0;
 const handler=withHermesGeneration(client=>createGymOperator({model:()=>client,now:()=>new Date('2026-11-04T12:00:00Z'),reader:()=>({
  describeSchema:async()=>({'gym.ezf_active_memberships':['location_id','bridge_class']}),
  query:async(sql:string)=>{reads++;return sql.includes('data_as_of') ? {columns:['data_as_of'],rows:[{data_as_of:'2026-10-30T12:00:00Z'}],truncated:false} : {columns:['location_id','active_individual_members'],rows:[{location_id:'synthetic',active_individual_members:1}],truncated:false};}
 })}),{run:async p=>{
   modelCalls++;const r=fixture();
   if(modelCalls===1)r.text=JSON.stringify({text:'',calls:[{name:'describe_gym_schema',input:{}}]});
   else {assert.ok(p.user.includes('tool_result'));r.text=JSON.stringify({text:'',calls:[{name:'submit_answer',input:{sql:'select location_id,count(*) active_individual_members from gym.ezf_active_memberships group by location_id',definition:'SYNTHETIC TEST MATCHED_INDIVIDUAL',freshness_sql:'select min(report_as_of) as data_as_of from gym.ezf_active_memberships'}}]});}
   return r;
 }});
 const r=await handler({runId:'synthetic',attemptNo:1,task:'SYNTHETIC TEST ONLY',decisions:[]});
 assert.equal(modelCalls,2);assert.equal(reads,2);assert.equal(r.body.data_age_days,5);assert.ok(r.evidence.some(e=>e.kind==='sql_trace'));assert.equal(r.evidence.filter(e=>e.kind==='hermes_transport').length,2);
});
