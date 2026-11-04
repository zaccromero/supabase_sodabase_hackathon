export type TrustVerdict = 'trusted' | 'caveated' | 'untrusted' | 'unknown' | 'scanning';
export type ConnectionState = 'ready' | 'missing_credentials' | 'authentication_required' | 'unavailable' | 'wrong_project';
export interface ConnectionStatus {
  state: ConnectionState;
  observed_at: string;
  endpoint: 'https://sodabase.io/mcp';
  credential_present: boolean;
  tools: string[];
  reason: string;
}
export interface ProviderEvidence {
  provider: 'sodabase';
  tool: 'data_trust' | 'check_rule';
  target: string;
  observed_at: string; // local retrieval time; never claimed to be scan time
  provider_checked_at: string | null;
  state: 'received' | 'pending' | 'unknown' | 'blocked' | 'error';
  verdict: TrustVerdict;
  reason: string;
  rule_status?: 'pass' | 'fail' | 'unknown' | 'unsupported' | 'ambiguous';
  // Server-side evidence only. Do not render arbitrary provider text as HTML.
  raw: unknown | null;
}
export type ReadTool = 'data_trust' | 'data_trust_health' | 'list_inbox' | 'explain' | 'check_rule';
export interface ReadToolClient {
  callReadTool(name: ReadTool, args: Record<string, unknown>): Promise<unknown>;
}
