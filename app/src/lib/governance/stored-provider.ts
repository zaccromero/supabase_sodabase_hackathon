/** Portable server-side integration: read existing normalized Sodabase rows, never call provider/model. */
import {assessRunnerRun,type ReaderDb,type ProviderEvidence,type TrustPorts} from './runner-bridge';
export interface StoredProviderOptions { projectRef: string; sameDatasetSnapshot?: boolean; }
const iso=(value:unknown)=>value instanceof Date?value.toISOString():typeof value==='string'?value:new Date().toISOString();
export function storedProviderPorts(db:ReaderDb,options:StoredProviderOptions):TrustPorts {
  if(!/^[a-z0-9]{20}$/.test(options.projectRef))throw Error('Explicit trusted project reference required');
  async function rows(table:string,tools:string[]) {
    return db.withRole('dashboard_reader',tx=>tx.query(`select id,provider,table_name,verdict,problem,finding_count,observed_at,raw
      from cm.quality_findings where provider='sodabase' and table_name=$1 and raw->>'tool'=any($2::text[])
      order by observed_at desc,id desc limit 16`,[table,tools]));
  }
  const binding=(row:Record<string,any>)=>row.raw?.binding?.project_ref===options.projectRef;
  return {
    sameDatasetSnapshot:options.sameDatasetSnapshot===true,
    dataTrust:async table=>{
      const candidates=await rows(table,['data_trust','data_trust_health']);
      const row=candidates[0];
      const tool=row?.raw?.tool==='data_trust'?'data_trust':'data_trust_health';
      const matched=!!row&&binding(row);
      const verdict=matched&&['trusted','caveated','untrusted','unknown','scanning'].includes(row.verdict)?row.verdict:'unknown';
      return {provider:'sodabase',tool,target:table,observed_at:iso(row?.observed_at),provider_checked_at:null,
        state:verdict==='scanning'?'pending':verdict==='unknown'?'unknown':'received',verdict,
        reason:matched?`Stored Sodabase ${tool}: ${verdict}. Existing observation; no new scan.`:'No current stored provider row with the expected project binding.',
        raw:{quality_finding_id:row?.id??null,project_binding:matched?'PASS':'UNKNOWN',record:row??null}} as ProviderEvidence;
    },
    checkRule:async(table,requestedRule)=>{
      const candidates=await rows(table,['check_rule']);
      const bound=candidates.filter(binding);
      const exact=bound.find(row=>row.problem===requestedRule&&row.raw?.provider_status==='pass');
      return {provider:'sodabase',tool:'check_rule',target:table,observed_at:iso(candidates[0]?.observed_at),provider_checked_at:null,
        state:exact?'received':'unknown',verdict:'unknown',
        reason:exact?'The exact requested rule has a retained provider pass. No broader trust inferred.':'Separate retained rule findings do not establish the requested combined rule.',
        raw:{requested_rule:requestedRule,quality_finding_ids:bound.map(row=>row.id),records:bound}};
    },
  };
}
/** API/data loader hook; safe for the existing public app server with its own database credentials. */
export function assessStoredGovernance(db:ReaderDb,runId:string,options:StoredProviderOptions) {
  return assessRunnerRun(db,runId,storedProviderPorts(db,options));
}
