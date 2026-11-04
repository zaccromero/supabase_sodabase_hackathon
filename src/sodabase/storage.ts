import type {ProviderEvidence} from './types.js';
/** Matches cm.quality_findings in 001_core.sql. Persistence belongs to integration owner. */
export interface QualityFindingInsert {
  provider: 'sodabase';
  provider_finding_id: null;
  table_name: string;
  verdict: string;
  problem: string;
  finding_count: null;
  severity: null;
  observed_at: string;
  raw: Record<string, unknown>;
}
export function toQualityFinding(result: ProviderEvidence): QualityFindingInsert | null {
  // A connection failure is not a real Sodabase finding.
  if (result.raw === null || result.state === 'blocked' || result.state === 'error') return null;
  return {
    provider: 'sodabase', provider_finding_id: null, table_name: result.target,
    verdict: result.verdict, problem: result.reason, finding_count: null, severity: null,
    observed_at: result.observed_at,
    raw: {tool: result.tool, state: result.state, rule_status: result.rule_status ?? null, provider_checked_at: result.provider_checked_at, response: result.raw},
  };
}
