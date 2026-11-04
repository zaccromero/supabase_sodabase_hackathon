import type {Evaluator, EvaluationBinding, CheckSpec} from '../contract/types.js';
import {canonicalJson, sha256} from '../contract/hash.js';
import {evaluate} from './core.js';
import type {Binding, Check, Evidence, ModelCritic} from './core.js';
/** Loaded by evaluator_service from trusted storage, never supplied by editing agent. */
export interface EvaluationContext {
  frozenAt: string;
  checks: CheckSpec[];
  editingAgentId: string;
  evidence: Array<{id: string; binding: EvaluationBinding; kind: string; text: string}>;
}
export interface EvaluatorOptions {
  evaluatorId: string;
  evaluatorVersion?: string;
  loadContext(binding: EvaluationBinding): Promise<EvaluationContext>;
  critic?: ModelCritic;
}
function binding(b: EvaluationBinding): Binding {
  return {runId:b.run_id, attempt:0, attemptId:b.attempt_id, outputId:b.output_id,
    outputRevision:b.output_sha256, contractId:b.contract_id, contractRevision:b.contract_sha256};
}
/** Frozen deterministic specs use type=decision|suggested_steps (required_steps also accepted). */
function check(c: CheckSpec): Check {
  const s=c.spec;
  return {id:c.check_id,kind:c.kind === 'critic' ? 'critic' : s.type === 'required_steps' || s.type === 'suggested_steps' ? 'required_steps' : 'decision',
    required:c.required,decisionId:c.decision_id ?? undefined,decisionVersion:s.decision_version as number | undefined,
    requiredPhrases:s.required_phrases as string[] | undefined, forbiddenPhrases:s.forbidden_phrases as string[] | undefined,
    steps:s.steps as Check['steps'],criterion:s.criterion as string | undefined};
}
const frozenShape=(c:CheckSpec)=>({check_id:c.check_id,kind:c.kind,required:c.required,
  requires_evidence:c.requires_evidence,decision_id:c.decision_id ?? null,spec:c.spec});
/** Compares a check to its stored row, where an absent decision_id comes back as null. */
export const canonicalCheck=(c:CheckSpec):string=>canonicalJson(frozenShape(c));
/** Matches the runner's contractHash: sorted checks, explicit nullable decision_id. */
export function frozenChecksHash(checks: CheckSpec[]): string {
  return sha256(checks.map(frozenShape).sort((a,b)=>a.check_id<b.check_id?-1:a.check_id>b.check_id?1:0));
}
export function createEvaluator(options: EvaluatorOptions): Evaluator {
  return async original => {
    const input=structuredClone(original);
    const receipt=(verdict:'pass'|'fail'|'uncertain',reason:string,refs:string[]=[])=>({check_id:input.check.check_id,verdict,reason,
      evaluator:options.evaluatorId,evaluator_version:options.evaluatorVersion ?? '1',
      evidence:{kind:'behavioral_evaluation',payload:{binding:input.binding,check_id:input.check.check_id,verdict,reason,evidence_refs:refs}}});
    try {
      if (sha256(input.output) !== input.binding.output_sha256) return receipt('fail','Output content hash mismatch');
      const context=await options.loadContext(input.binding);
      if (frozenChecksHash(context.checks) !== input.binding.contract_sha256) return receipt('fail','Frozen checks content hash mismatch');
      if (!context.checks.some(c=>frozenChecksHash([c])===frozenChecksHash([input.check]))) return receipt('fail','Check not in frozen contract');
      const translated=check(input.check);
      // Check a frozen selected field (e.g. Milo 'after'), preserving historical 'before'.
      let checkedOutput: unknown=input.output;
      const path=input.check.spec.output_path;
      if(path !== undefined) {
        if(!Array.isArray(path) || !path.length || !path.every(p=>typeof p === 'string' && p.length>0))
          return receipt('uncertain','Invalid frozen output_path');
        for(const segment of path) {
          if(!checkedOutput || typeof checkedOutput !== 'object' || !Object.hasOwn(checkedOutput,segment))
            return receipt('fail','Required output field missing');
          checkedOutput=(checkedOutput as Record<string,unknown>)[segment];
        }
      }
      const current=context.evidence.filter(e=>canonicalJson(e.binding)===canonicalJson(input.binding));
      if(input.check.requires_evidence && current.length===0) return receipt('fail','Missing current source evidence');
      const evidence: Evidence[]=context.evidence.map(e=>({...binding(e.binding),id:e.id,kind:e.kind,text:e.text}));
      const evaluated=await evaluate({binding:binding(input.binding),output:typeof checkedOutput === 'string' ? checkedOutput : canonicalJson(checkedOutput),
        editingAgentId:context.editingAgentId,evaluatorId:options.evaluatorId,
        contract:{id:input.binding.contract_id,revision:input.binding.contract_sha256,frozenAt:context.frozenAt,checks:context.checks.map(check)},
        pinnedDecisions:input.decisions.map(d=>({id:d.id,version:d.version,status:'accepted',statement:d.statement})), evidence},translated,options.critic);
      return receipt(evaluated.verdict,evaluated.reason,evaluated.evidenceRefs);
    } catch {
      return receipt('uncertain','Evaluator context/specification unavailable or malformed');
    }
  };
}
