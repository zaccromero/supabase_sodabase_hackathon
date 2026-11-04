import type { ProviderEvidence, ReadToolClient, TrustVerdict } from './types.js';
const verdicts = new Set<TrustVerdict>(['trusted', 'caveated', 'untrusted', 'unknown', 'scanning']);
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function payload(raw: unknown): Record<string, unknown> | null {
  const result = object(raw);
  let data = object(result?.structuredContent);
  if (!data && Array.isArray(result?.content)) {
    const texts = result.content.filter((c: unknown) => object(c)?.type === 'text');
    if (texts.length === 1) {
      try { data = object(JSON.parse(String(object(texts[0])?.text))); } catch { return null; }
    }
  }
  // Live Sodabase0.2.0 advertises outputSchema {result:string}.
  if (typeof data?.result === 'string') {
    try { return object(JSON.parse(data.result)); } catch { return null; }
  }
  return data;
}
/** No heuristic extraction from prose. Unknown response shapes stay unknown. */
export function normalizeTrust(raw: unknown, table: string, observedAt = new Date().toISOString()): ProviderEvidence {
  const result = object(raw);
  const base: ProviderEvidence = {provider: 'sodabase', tool: 'data_trust', target: table, observed_at: observedAt, provider_checked_at: null, state: 'unknown', verdict: 'unknown', reason: 'Provider response has no recognized structured verdict; inspect retained evidence.', raw};
  if (result?.isError === true) return {...base, state: 'error', reason: 'Sodabase returned a tool error.'};
  const data = payload(raw);
  // Only an explicit exact verdict counts. Counts and numeric quality scores are never inferred.
  const verdict = data?.status ?? data?.verdict;
  if (typeof verdict !== 'string' || !verdicts.has(verdict as TrustVerdict)) return base;
  const timestamp = data?.checked_at;
  return {...base, verdict: verdict as TrustVerdict, state: verdict === 'scanning' ? 'pending' : verdict === 'unknown' ? 'unknown' : 'received', provider_checked_at: typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : null, reason: typeof data?.reason === 'string' ? data.reason : `Sodabase reported ${verdict}.`};
}
export async function dataTrust(client: ReadToolClient, table: string): Promise<ProviderEvidence> {
  if (!table.trim()) throw new Error('Table is required');
  try { return normalizeTrust(await client.callReadTool('data_trust', {table}), table); }
  catch { return {provider: 'sodabase', tool: 'data_trust', target: table, observed_at: new Date().toISOString(), provider_checked_at: null, state: 'blocked', verdict: 'unknown', reason: 'Trust retrieval failed or connection is unavailable.', raw: null}; }
}
export async function checkRule(client: ReadToolClient, dataset: string, rule: string): Promise<ProviderEvidence> {
  if (!dataset.trim() || !rule.trim()) throw new Error('Dataset and rule are required');
  try {
    const raw = await client.callReadTool('check_rule', {dataset, rule, persist: false});
    const failed = object(raw)?.isError === true;
    const status = payload(raw)?.status;
    const ruleStatus = typeof status === 'string' && ['pass', 'fail', 'unknown', 'unsupported', 'ambiguous'].includes(status) ? status as ProviderEvidence['rule_status'] : undefined;
    return {provider: 'sodabase', tool: 'check_rule', target: dataset, observed_at: new Date().toISOString(), provider_checked_at: null, state: failed ? 'error' : ruleStatus === 'unknown' || ruleStatus === 'unsupported' || ruleStatus === 'ambiguous' ? 'unknown' : 'received', verdict: 'unknown', rule_status: ruleStatus, reason: failed ? 'Sodabase returned a tool error.' : 'Non-persistent rule response retained. No trust verdict or violation count inferred from an unverified response schema.', raw};
  } catch { return {provider: 'sodabase', tool: 'check_rule', target: dataset, observed_at: new Date().toISOString(), provider_checked_at: null, state: 'blocked', verdict: 'unknown', reason: 'Rule check failed or connection is unavailable.', raw: null}; }
}
