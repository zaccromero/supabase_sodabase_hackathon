import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { structured } from './adapters.js';
import { SODABASE_PROJECT_REF } from './client.js';
import { assertRuleAllowed, classifyProblem, INTEGRITY_RULES, type Disposition, type IntegrityRule } from './rules.js';
import { sanitize, scrubText } from './sanitize.js';
import type { ConnectionStatus, ReadToolClient } from './types.js';

export interface PullClient extends ReadToolClient {
  /** A test double must say so; its results can never become a committed receipt. */
  readonly provenance: 'live' | 'test_double';
  connect(): Promise<ConnectionStatus>;
  verifyProject(ref?: string): Promise<boolean>;
  close(): Promise<void>;
}
export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; }
export interface QualityRow {
  provider: 'sodabase'; provider_finding_id: string | null; table_name: string; verdict: string; problem: string | null;
  finding_count: number | null; severity: string | null; observed_at: string; raw: Record<string, unknown>;
}
export interface PullResult {
  status: ConnectionStatus; provenance: PullClient['provenance']; observed_at: string; rows: QualityRow[];
  counts: Record<Disposition | 'clean' | 'undetermined' | 'unparsed' | 'errors', number>;
  /** A table count of zero means nothing was checked. It is not a healthy result. */
  quality_evidence: 'NOT_RUN' | 'RECEIVED' | 'NO_SCANS_YET' | 'NO_WATCHED_TABLES' | 'UNPARSED';
  receipt_path: string | null; inserted: number; database_error: string | null;
}

export const DEFAULT_RECEIPTS_DIR = 'docs/receipts';
const SCOPE_NOTE = 'Sodabase checks data integrity of watched tables. It does not judge conversations or whether an agent followed a decision, and nothing here can pass or block a run.';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const firstString = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string; return null; };
const firstNumber = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number; return null; };

/** The provider's own plain-text answers for empty states, seen live on 4 Nov 2026. Neither is a statement about data health. */
const NO_SCANS = /no data-trust scans yet/i;
const INBOX_CLEAR = /inbox is clear/i;
function proseResult(raw: unknown): string {
  if (!isObject(raw)) return '';
  if (isObject(raw.structuredContent) && typeof raw.structuredContent.result === 'string') return raw.structuredContent.result;
  return '';
}

function listOf(data: unknown, keys: string[]): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data.filter(isObject);
  if (isObject(data)) for (const k of keys) if (Array.isArray(data[k])) return (data[k] as unknown[]).filter(isObject);
  return null;
}
const TABLE_KEYS = ['table', 'table_name', 'dataset', 'name'];
const PROBLEM_TEXT = ['problem', 'title', 'summary', 'description', 'message', 'kind'];
const STATUS_KEYS = ['status', 'verdict'];
const COUNT_KEYS = ['failing_count', 'count', 'finding_count', 'violations', 'violation_count', 'breaking_rows', 'rows_breaking', 'failing_rows', 'rows'];
const ID_KEYS = ['finding_id', 'id', 'issue_id'];

function toRow(tool: string, table: string, verdict: string, p: Record<string, unknown> | null, observedAt: string, extra: Record<string, unknown> = {}): QualityRow {
  const problem = p ? firstString(p, PROBLEM_TEXT) : null;
  const text = problem ? scrubText(problem) : null;
  const { disposition, never_flag_id } = text ? classifyProblem(`${table} ${text}`) : { disposition: undefined, never_flag_id: undefined };
  return {
    provider: 'sodabase', provider_finding_id: p ? firstString(p, ID_KEYS) : null, table_name: table, verdict, problem: text,
    finding_count: p ? firstNumber(p, COUNT_KEYS) : null, severity: p ? firstString(p, ['severity', 'level']) : null, observed_at: observedAt,
    raw: { tool, ...(disposition ? { disposition } : {}), ...(never_flag_id ? { never_flag_id } : {}), ...extra, response: sanitize(p) },
  };
}

function healthRows(raw: unknown, observedAt: string): { rows: QualityRow[]; parsed: boolean; tables: number } {
  const tables = listOf(structured(raw), ['tables', 'datasets', 'results', 'items', 'verdicts']);
  if (!tables) return { rows: [], parsed: false, tables: 0 };
  const rows: QualityRow[] = [];
  for (const t of tables) {
    const table = firstString(t, TABLE_KEYS);
    const verdict = firstString(t, STATUS_KEYS);
    if (!table || !verdict) continue;
    const problems = listOf(t, ['problems', 'findings', 'issues']) ?? [];
    if (problems.length === 0) rows.push(toRow('data_trust_health', table, verdict, null, observedAt));
    for (const p of problems) rows.push(toRow('data_trust_health', table, verdict, p, observedAt));
  }
  return { rows, parsed: true, tables: tables.length };
}

function inboxRows(raw: unknown, observedAt: string, known: Set<string>): { rows: QualityRow[]; parsed: boolean } {
  const items = listOf(structured(raw), ['issues', 'items', 'inbox', 'results']);
  if (!items) return { rows: [], parsed: false };
  const rows: QualityRow[] = [];
  for (const item of items) {
    const id = firstString(item, ID_KEYS);
    if (id && known.has(id)) continue;
    rows.push(toRow('list_inbox', firstString(item, TABLE_KEYS) ?? 'unknown', firstString(item, STATUS_KEYS) ?? 'open', item, observedAt));
  }
  return { rows, parsed: true };
}

function ruleRow(rule: IntegrityRule, raw: unknown, observedAt: string): QualityRow {
  const data = structured(raw);
  const status = isObject(data) ? firstString(data, ['status']) : null;
  // The provider says to branch on status. A count alone never decides, and no status is unknown, never held.
  const fromStatus: Record<string, string> = { pass: 'rule_held', fail: 'rule_breached', unknown: 'rule_unknown', unsupported: 'rule_unsupported', ambiguous: 'rule_ambiguous' };
  const verdict = rule.status === 'exploratory' ? 'exploratory' : (status && fromStatus[status]) || 'unknown';
  const disposition = rule.status === 'exploratory' ? 'exploratory' : verdict === 'rule_breached' ? 'actionable' : undefined;
  return {
    provider: 'sodabase', provider_finding_id: null, table_name: rule.dataset, verdict, problem: rule.rule,
    finding_count: isObject(data) ? firstNumber(data, COUNT_KEYS) : null, severity: null, observed_at: observedAt,
    raw: { tool: 'check_rule', rule_id: rule.id, rule_status: rule.status, provider_status: status, basis: rule.basis, ...(disposition ? { disposition } : {}), response: sanitize(raw) },
  };
}

export async function insertQualityRows(db: Queryable, rows: QualityRow[]): Promise<number> {
  const who = await db.query('select current_user as role');
  if (who.rows[0]?.role !== 'evaluator_service') throw new Error('Quality findings must be written as evaluator_service');
  for (const r of rows) {
    await db.query(
      `insert into cm.quality_findings (provider, provider_finding_id, table_name, verdict, problem, finding_count, severity, observed_at, raw) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
      [r.provider, r.provider_finding_id, r.table_name, r.verdict, r.problem, r.finding_count, r.severity, r.observed_at, JSON.stringify(r.raw)]);
  }
  return rows.length;
}

export interface PullOptions {
  /** Already acting as evaluator_service. Omit to produce the receipt only. */
  db?: Queryable;
  receiptsDir?: string;
  runRules?: boolean;
  rules?: IntegrityRule[];
  /** Fetch the root-cause story for this many inbox and health findings. */
  explainLimit?: number;
  now?: () => Date;
}

/**
 * Real results only. If the connection is not ready this writes nothing at all: an absent credential is not a finding,
 * and no receipt means no evidence. Provider responses we cannot parse stay in the receipt as unparsed, with no rows.
 */
export async function pullFindings(client: PullClient, options: PullOptions = {}): Promise<PullResult> {
  const now = options.now ?? (() => new Date());
  const receiptsDir = options.receiptsDir ?? DEFAULT_RECEIPTS_DIR;
  if (client.provenance !== 'live' && resolve(receiptsDir) === resolve(DEFAULT_RECEIPTS_DIR)) {
    throw new Error('A test double cannot write to docs/receipts');
  }
  const counts: PullResult['counts'] = { actionable: 0, expected_by_definition: 0, exploratory: 0, clean: 0, undetermined: 0, unparsed: 0, errors: 0 };
  const status = await client.connect();
  const observedAt = now().toISOString();
  const blocked = (s: ConnectionStatus): PullResult => ({ status: s, provenance: client.provenance, observed_at: observedAt, rows: [], counts, quality_evidence: 'NOT_RUN', receipt_path: null, inserted: 0, database_error: null });
  if (status.state !== 'ready') { await client.close(); return blocked(status); }
  if (!(await client.verifyProject(SODABASE_PROJECT_REF))) {
    await client.close();
    return blocked({ ...status, state: 'wrong_project', reason: `This Sodabase workspace does not list project ${SODABASE_PROJECT_REF}, so nothing was read.` });
  }

  const calls: Array<Record<string, unknown>> = [];
  const call = async (tool: Parameters<ReadToolClient['callReadTool']>[0], args: Record<string, unknown>): Promise<unknown | null> => {
    try {
      const raw = await client.callReadTool(tool, args);
      const isError = isObject(raw) && raw.isError === true;
      if (isError) counts.errors++;
      const parsed = structured(raw) !== null;
      calls.push({ tool, ok: !isError, parsed, ...(parsed ? {} : { unparsed_response: sanitize(raw) }) });
      return isError ? null : raw;
    } catch {
      // Errors are not recorded verbatim: upstream text can hold credentials.
      counts.errors++;
      calls.push({ tool, ok: false });
      return null;
    }
  };

  try {
    const rows: QualityRow[] = [];
    let quality: PullResult['quality_evidence'] = 'NOT_RUN';
    if (status.tools.includes('data_trust_health')) {
      const raw = await call('data_trust_health', {});
      if (raw) {
        const h = healthRows(raw, observedAt);
        rows.push(...h.rows);
        const noScans = !h.parsed && NO_SCANS.test(proseResult(raw));
        if (!h.parsed && !noScans) counts.unparsed++;
        quality = noScans ? 'NO_SCANS_YET' : !h.parsed ? 'UNPARSED' : h.tables === 0 ? 'NO_WATCHED_TABLES' : 'RECEIVED';
      }
    }
    if (status.tools.includes('list_inbox')) {
      const raw = await call('list_inbox', {});
      if (raw) {
        const known = new Set(rows.map((r) => r.provider_finding_id).filter((x): x is string => !!x));
        const i = inboxRows(raw, observedAt, known); rows.push(...i.rows); if (!i.parsed && !INBOX_CLEAR.test(proseResult(raw))) counts.unparsed++;
      }
    }
    if (status.tools.includes('explain')) {
      const targets = rows.filter((r) => r.provider_finding_id && r.raw.disposition === 'actionable').slice(0, options.explainLimit ?? 5);
      for (const r of targets) {
        const raw = await call('explain', { id: r.provider_finding_id });
        if (raw) r.raw.explanation = sanitize(raw);
      }
    }
    if (options.runRules && status.tools.includes('check_rule')) {
      for (const rule of options.rules ?? INTEGRITY_RULES) {
        assertRuleAllowed(rule);
        const raw = await call('check_rule', { dataset: rule.dataset, rule: rule.rule, persist: false });
        if (raw) rows.push(ruleRow(rule, raw, observedAt));
      }
    }
    for (const r of rows) {
      const d = r.raw.disposition as Disposition | undefined;
      if (d) counts[d]++;
      else if (r.verdict === 'trusted' || r.verdict === 'rule_held') counts.clean++;
      else counts.undetermined++;
    }

    // A database failure must not lose real provider results, so the receipt is still written. Only the code is kept.
    let inserted = 0;
    let databaseError: string | null = null;
    if (options.db) {
      try {
        inserted = await insertQualityRows(options.db, rows);
      } catch (e) {
        const code = (e as { code?: unknown }).code;
        databaseError = typeof code === 'string' ? code : (e as Error).name;
      }
    }
    mkdirSync(receiptsDir, { recursive: true });
    const receiptPath = join(receiptsDir, `sodabase-${observedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.json`);
    writeFileSync(receiptPath, `${JSON.stringify({
      provider: 'sodabase', provenance: client.provenance, endpoint: status.endpoint, project_ref: SODABASE_PROJECT_REF, observed_at: observedAt, scope: SCOPE_NOTE,
      quality_evidence: quality,
      tools_discovered: status.tools, tool_calls: calls, counts, inserted_into_quality_findings: inserted, database_error: databaseError, findings: rows,
    }, null, 2)}\n`);
    return { status, provenance: client.provenance, observed_at: observedAt, rows, counts, quality_evidence: quality, receipt_path: receiptPath, inserted, database_error: databaseError };
  } finally {
    await client.close();
  }
}
