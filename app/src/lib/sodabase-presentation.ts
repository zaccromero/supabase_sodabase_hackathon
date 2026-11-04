/** Server-side presentation only. Provider verdicts remain visible and are never rewritten. */
export interface QualityPresentationRow {
  provider_finding_id: string | null;
  table_name: string;
  verdict: string;
  problem: string | null;
  finding_count: number | null;
  observed_at: string | Date;
  disposition?: string | null;
}
export interface QualityPresentationScope {projectRef: string; mirrorRunId: string;}
export interface QualityPresentation {group: 'review' | 'expected' | 'coverage' | 'passed' | 'pending'; label: string; explanation: string; providerVerdict: string; storedDisposition: string | null;}
const project='dgqcanfiapxztmqqlqnh';
const mirror='c08024fa-3825-4c69-96b9-d9a83e08703b';
const expected: Record<string,{count: number; explanation: string}> = {
 'f6672df4-d93f-4d2c-abb0-42e7485471a0':{count:28,explanation:'All 28 use the documented combined-location value “all”. These rollups are expected; do not delete them.'},
 'a0916704-dd17-4cd7-a6e8-808176ea4f8f':{count:28,explanation:'The combined-location rollup is documented behavior, not a missing gym.'},
 'bbee4bad-6a19-4ae3-917b-a320b997da95':{count:1,explanation:'Validated group: one matched individual plus one deliberately excluded additional membership, with distinct source keys.'},
 '6ac59cf6-da38-4ed3-a83a-db79b026b1ff':{count:1,explanation:'Validated additional membership is intentionally excluded from the individual count; it is not an accidental duplicate.'},
 'beeef2aa-55e7-4cee-a502-a7f6191d7136':{count:6,explanation:'The original approval predates the later database import. Import time is not the original decision time.'},
 '8cd9cc17-c091-4794-9381-7ddc1ee4eff3':{count:6,explanation:'All six are first versions; having no predecessor is expected.'},
};
const dates=new Set(['8806f2bb-a4cc-4f2b-ba55-151962c06b24','bdc24c5d-ce55-4515-b2f0-dacc45eaf8c8']);
const coordinates=new Set(['bef480b0-b5ee-45a3-aa71-e74d35e09c1a','c6b24da7-3a8a-4db3-81d5-985859249121']);
export function presentQuality(row:QualityPresentationRow,scope:QualityPresentationScope):QualityPresentation {
 const base={providerVerdict:row.verdict,storedDisposition:row.disposition??null};
 const reviewedMirror=scope.projectRef===project&&scope.mirrorRunId===mirror;
 const memberTable=row.table_name==='gym.members'||row.table_name===`${project}/postgres/gym/members`;
 const dateRule=row.problem?.trim();
 const unresolvedDate=memberTable&&(
  (row.finding_count===91&&dateRule==='Rule broken: joined_at must be on or before expiration_date')||
  (row.finding_count===52&&dateRule==='Rule broken: joined_at must be on or before churned_at'));
 if(reviewedMirror&&unresolvedDate)return {...base,group:'review',label:'Needs review · field semantics unresolved',explanation:'Client-record creation is being compared with contract expiry or cancellation-status dates, not membership activation. These observations are not all proven expected or defective. Only two separately documented 1980 expiry placeholders are normalized to unknown; raw values and provider findings remain unchanged. Stored disposition is retained as provenance, not a validated conclusion.'};
 const at=row.observed_at instanceof Date?row.observed_at.getTime():Date.parse(row.observed_at);
 const verified=scope.projectRef===project&&scope.mirrorRunId===mirror&&at>=Date.parse('2026-11-04T22:15:51Z')&&at<=Date.parse('2026-11-04T22:38:30Z');
 const known=row.provider_finding_id?expected[row.provider_finding_id]:undefined;
 if(verified&&known&&row.finding_count===known.count)return {...base,group:'expected',label:'Expected by definition',explanation:known.explanation};
 if(row.disposition==='expected_by_definition')return {...base,group:'expected',label:'Expected by definition',explanation:'The stored observation is classified as expected by the integration checks. Provider verdict is preserved below.'};
 if(verified&&row.provider_finding_id&&dates.has(row.provider_finding_id))return {...base,group:'review',label:'Confirmed observation · investigate cause',explanation:'Full-table SQL confirms this count. Date lineage needs review; no cause or automatic repair has been established.'};
 if(verified&&row.provider_finding_id&&coordinates.has(row.provider_finding_id))return {...base,group:'coverage',label:'Coverage gap',explanation:'Location coordinates are missing. Neighborhood and radius comparisons are not supported yet.'};
 if(row.verdict==='trusted'||row.verdict==='rule_held')return {...base,group:'passed',label:'Reported pass',explanation:'A specific provider check passed. This does not certify the whole dataset.'};
 if(['unknown','scanning','rule_unknown','rule_unsupported','rule_ambiguous','exploratory'].includes(row.verdict))return {...base,group:'pending',label:row.verdict==='scanning'?'Scan pending':'Unresolved / not checked',explanation:'Unknown, unsupported and exploratory results are not passes.'};
 return {...base,group:'review',label:'Needs review',explanation:'Provider finding; validate the business definition and source coverage before treating it as a defect.'};
}
export const QUALITY_GROUP_ORDER=['review','coverage','expected','passed','pending'] as const;

export function presentSourceCoverage(scope:QualityPresentationScope):{label:string;note:string} {
 if(scope.projectRef===project&&scope.mirrorRunId===mirror)return {
  label:'Stale DEV snapshot — not current Gym counts',
  note:'Membership reports are dated October 5, 2026; newest member sync and check-in are October 15. East 3rd’s latest membership sync failed, so its retained projection is partial. Importing or scanning today does not refresh those source dates.',
 };
 return {label:'Source freshness unverified',note:'This mirror is not the verified October DEV snapshot. Check its actual source timestamps and location completeness before using current counts.'};
}
