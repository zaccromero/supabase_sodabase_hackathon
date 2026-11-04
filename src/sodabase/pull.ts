import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertRuleAllowed, classifyProblem, INTEGRITY_RULES, type Disposition, type IntegrityRule } from './rules.js';
import { sanitize, scrubText } from './sanitize.js';
import type { ConnectionStatus, ReadToolClient } from './types.js';

export interface PullClient extends ReadToolClient {
  /** A test double must say so; its results can never become a committed receipt. */
  readonly provenance: 'live' | 'test_double';
  connect(): Promise<ConnectionStatus>;
  close(): Promise<void>;
}
export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; }
export interface QualityRow {
  provider: 'sodabase'; provider_finding_id: string | null; table_name: string; verdict: string; problem: string | null;
  finding_count: number | null; severity: string | null; observed_at: string; raw: Record<string, unknown>;
}
export interface PullResult {
  status: ConnectionStatus; provenance: PullClient['provenance']; observed_at: string; rows: QualityRow[];
  counts: Record<Disposition | 'clean' | 'unparsed' | 'errors', number>; receipt_path: string | null; inserted: number;
}

export const DEFAULT_RECEIPTS_DIR = 'docs/receipts';
const SCOPE_NOTE = 'Sodabase checks data integrity of watched tables. It does not judge conversations or whether an agent followed a decision, and nothing here can pass or block a run.';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const firstString = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof o[k] === 'string' && o[k]) return o[k] as string; return null; };
const firstNumber = (o: Record<string, unknown>, keys: string[]) => { for (const k of keys) if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number; return null; };

/** The MCP envelope's structured data, or a single JSON text block. Prose stays prose and yields no rows. */
export function structured(raw: unknown): unknown {
  if (!isObject(raw) || raw.isError === true) return null;
  if (raw.structuredContent !== undefined) return raw.structuredContent;
  if (Array.isArray(raw.content)) {
    const texts = raw.content.filter((c) => isObject(c) && c.type === 'text');
    if (texts.length === 1) { try { return JSON.parse(String((texts[0] as { text: unknown }).text)); } catch { return null; } }
  }
  return null;
}

function listOf(data: unknown, keys: string[]): Record<string, unknown>[] | null {
  if (Array.isArray(data)) return data.filter(isObject);
  if (isObject(data)) for (const k of keys) if (Array.isArray(data[k])) return (data[k] as unknown[]).filter(isObject);
  return null;
}
const TABLE_KEYS = ['table', 'table_name', 'dataset', 'name'];
const PROBLEM_TEXT = ['problem', 'title', 'summary', 'description', 'message'];
const COUNT_KEYS = ['count', 'finding_count', 'violations', 'violation_count', 'breaking_rows', 'rows_breaking', 'failing_rows', 'rows'];
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

function healthRows(raw: unknown, observedAt: string): { rows: QualityRow[]; parsed: boolean } {
  const tables = listOf(structured(raw), ['tables', 'datasets', 'results', 'items', 'verdicts']);
  if (!tables) return { rows: [], parsed: false };
  const rows: QualityRow[] = [];
  for (const t of tables) {
    const table = firstString(t, TABLE_KEYS);
    const verdict = firstString(t, ['verdict', 'status']);
    if (!table || !verdict) continue;
    const problems = listOf(t, ['problems', 'findings', 'issues']) ?? [];
    if (problems.length === 0) rows.push(toRow('data_trust_health', table, verdict, null, observedAt));
    for (const p of problems) rows.push(toRow('data_trust_health', table, verdict, p, observedAt));
  }
  return { rows, parsed: true };
}

function inboxRows(raw: unknown, observedAt: string, known: Set<string>): { rows: QualityRow[]; parsed: boolean } {
  const items = listOf(structured(raw), ['issues', 'items', 'inbox', 'results']);
  if (!items) return { rows: [], parsed: false };
  const rows: QualityRow[] = [];
  for (const item of items) {
    const id = firstString(item, ID_KEYS);
    if (id && known.has(id)) continue;
    rows.push(toRow('list_inbox', firstString(item, TABLE_KEYS) ?? 'unknown', firstString(item, ['verdict', 'status']) ?? 'open', item, observedAt));
  }
  return { rows, parsed: true };
}

function ruleRow(rule: IntegrityRule, raw: unknown, observedAt: string): QualityRow {
  const data = structured(raw);
  const broken = isObject(data) ? firstNumber(data, COUNT_KEYS) : null;
  // A count is read only from an explicit numeric field. Without one, the verdict is unknown, never held.
  const verdict = rule.status === 'exploratory' ? 'exploratory' : broken === null ? 'unknown' : broken > 0 ? 'rule_breached' : 'rule_held';
  return {
    provider: 'sodabase', provider_finding_id: null, table_name: rule.dataset, verdict, problem: rule.rule, finding_count: broken, severity: null, observed_at: observedAt,
    raw: { tool: 'check_rule', rule_id: rule.id, rule_status: rule.status, basis: rule.basis, disposition: rule.status === 'exploratory' ? 'exploratory' : 'actionable', response: sanitize(raw) },
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
  const counts: PullResult['counts'] = { actionable: 0, expected_by_definition: 0, exploratory: 0, clean: 0, unparsed: 0, errors: 0 };
  const status = await client.connect();
  const observedAt = now().toISOString();
  const blocked: PullResult = { status, provenance: client.provenance, observed_at: observedAt, rows: [], counts, receipt_path: null, inserted: 0 };
  if (status.state !== 'ready') { await client.close(); return blocked; }

  const calls: Array<Record<string, unknown>> = [];
  const call = async (tool: Parameters<ReadToolClient['callReadTool']>[0], args: Record<string, unknown>): Promise<unknown | null> => {
    try {
      const raw = await client.callReadTool(tool, args);
      const isError = isObject(raw) && raw.isError === true;
      if (isError) counts.errors++;
      calls.push({ tool, ok: !isError, parsed: structured(raw) !== null, ...(structured(raw) === null ? { unparsed_response: sanitize(raw) } : {}) });
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
    if (status.tools.includes('data_trust_health')) {
      const raw = await call('data_trust_health', {});
      if (raw) { const h = healthRows(raw, observedAt); rows.push(...h.rows); if (!h.parsed) counts.unparsed++; }
    }
    if (status.tools.includes('list_inbox')) {
      const raw = await call('list_inbox', {});
      if (raw) {
        const known = new Set(rows.map((r) => r.provider_finding_id).filter((x): x is string => !!x));
        const i = inboxRows(raw, observedAt, known); rows.push(...i.rows); if (!i.parsed) counts.unparsed++;
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
      if (d) counts[d]++; else counts.clean++;
    }

    const inserted = options.db ? await insertQualityRows(options.db, rows) : 0;
    mkdirSync(receiptsDir, { recursive: true });
    const receiptPath = join(receiptsDir, `sodabase-${observedAt.replace(/\.\d+Z$/, 'Z').replace(/:/g, '-')}.json`);
    writeFileSync(receiptPath, `${JSON.stringify({
      provider: 'sodabase', provenance: client.provenance, endpoint: status.endpoint, observed_at: observedAt, scope: SCOPE_NOTE,
      tools_discovered: status.tools, tool_calls: calls, counts, inserted_into_quality_findings: inserted, findings: rows,
    }, null, 2)}\n`);
    return { status, provenance: client.provenance, observed_at: observedAt, rows, counts, receipt_path: receiptPath, inserted };
  } finally {
    await client.close();
  }
}
