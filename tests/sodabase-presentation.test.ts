import {describe,it,expect} from 'vitest';
import {presentQuality} from '../app/src/lib/sodabase-presentation';
const scope={projectRef:'dgqcanfiapxztmqqlqnh',mirrorRunId:'c08024fa-3825-4c69-96b9-d9a83e08703b'};
const base={provider_finding_id:null,table_name:'gym.members',verdict:'untrusted',observed_at:'2026-11-04T23:19:00Z',disposition:'expected_by_definition'};
describe('investigated quality presentation',()=>{
 it('does not call missing membership numbers expected based on nullability',()=>{
  const view=presentQuality({...base,problem:'Missing values: ezf_membership_number: should not be missing (null)',finding_count:64},scope);
  expect(view.group).toBe('coverage');expect(view.explanation).toContain('expired annual');expect(view.providerVerdict).toBe('untrusted');expect(view.storedDisposition).toBe('expected_by_definition');
 });
 it('preserves unresolved date comparisons and their original provenance',()=>{
  for(const [problem,count] of [['Rule broken: joined_at must be on or before expiration_date',91],['Rule broken: joined_at must be on or before churned_at',52],['gym.members — rule broken',143]] as const){
   const view=presentQuality({...base,problem,finding_count:count},scope);
   expect(view.group).toBe('review');expect(view.providerVerdict).toBe('untrusted');expect(view.storedDisposition).toBe('expected_by_definition');
  }
 });
});
