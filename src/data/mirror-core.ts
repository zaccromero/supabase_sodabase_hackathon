// Pure mirror logic. No credentials here. tools/mirror.ts wires it to Doppler and the databases.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { sha256 } from '../contract/hash';

export type ColumnType = 'text' | 'uuid' | 'timestamptz' | 'date' | 'int4' | 'float8' | 'bool';
export interface ColumnSpec { type: ColumnType; hash?: boolean; }
export interface TableSpec {
  table: string;
  mode: 'upsert' | 'full_replace';
  key: string[];
  where?: string;
  columns: Record<string, ColumnSpec>;
}
export interface Manifest {
  version: number;
  source: { doppler_project: string; doppler_config: string; schema: string };
  target: { schema: string };
  tables: TableSpec[];
}
export interface Queryable { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>; }
export type RawRow = Record<string, string | null>;

/** A column whose name matches this can never be allowlisted. */
export const FORBIDDEN_COLUMN = /name|email|phone|raw_|description|detail|message/;
export const HEX64 = /^[0-9a-f]{64}$/;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE_VALUE = /(?<![\d-])(\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?![\d-])/;

const MANIFEST_URL = new URL('../../export-manifest.json', import.meta.url);
export const loadManifest = (): Manifest => JSON.parse(readFileSync(MANIFEST_URL, 'utf8'));
export const manifestSha256 = () => sha256(loadManifest());

export function assertManifestSafe(m: Manifest): void {
  for (const t of m.tables) {
    for (const col of Object.keys(t.columns)) {
      if (FORBIDDEN_COLUMN.test(col)) throw new Error(`MANIFEST_FORBIDDEN_COLUMN: ${t.table}.${col}`);
    }
    for (const k of t.key) if (!t.columns[k]) throw new Error(`MANIFEST_KEY_NOT_ALLOWLISTED: ${t.table}.${k}`);
  }
}

export const hmacId = (pepper: string, value: string) => createHmac('sha256', pepper).update(value).digest('hex');

/**
 * Applies the allowlist and hashes identifiers. Source timestamps pass through as text, verbatim.
 * Refuses a value that looks like an email or phone number. The error names the column, never the value.
 */
export function transformRow(spec: TableSpec, row: RawRow, pepper: string): RawRow {
  if (!pepper) throw new Error('MIRROR_PEPPER_MISSING');
  const out: RawRow = {};
  for (const [col, c] of Object.entries(spec.columns)) {
    if (!(col in row)) throw new Error(`SOURCE_COLUMN_MISSING: ${spec.table}.${col}`);
    const v = row[col] ?? null;
    if (c.hash) {
      out[col] = v === null ? null : hmacId(pepper, v);
      continue;
    }
    if (v !== null && c.type === 'text' && !col.endsWith('_sha256') && (EMAIL_VALUE.test(v) || PHONE_VALUE.test(v))) {
      throw new Error(`PII_VALUE_REFUSED: ${spec.table}.${col}`);
    }
    out[col] = v;
  }
  return out;
}

export function selectSql(spec: TableSpec, sourceSchema: string): string {
  const cols = Object.keys(spec.columns).map((c) => `"${c}"::text as "${c}"`).join(', ');
  const where = spec.where ? ` where ${spec.where}` : '';
  return `select ${cols} from "${sourceSchema}"."${spec.table}"${where}`;
}

export const countSql = (spec: TableSpec, sourceSchema: string) =>
  `select count(*)::int n from "${sourceSchema}"."${spec.table}"${spec.where ? ` where ${spec.where}` : ''}`;

/** Text parameters cast through text, so pg and PGlite treat every value identically. */
export function upsertSql(spec: TableSpec, targetSchema: string, rowCount: number): string {
  const cols = Object.keys(spec.columns);
  const groups: string[] = [];
  let i = 1;
  for (let r = 0; r < rowCount; r++) {
    groups.push(`(${cols.map((c) => `$${i++}::text::${spec.columns[c]!.type}`).join(',')})`);
  }
  const updates = cols.filter((c) => !spec.key.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  const conflict = spec.key.map((k) => `"${k}"`).join(',');
  return `insert into "${targetSchema}"."${spec.table}" (${cols.map((c) => `"${c}"`).join(',')}) values ${groups.join(',')} on conflict (${conflict}) do update set ${updates}`;
}

export async function writeBatch(target: Queryable, spec: TableSpec, schema: string, rows: RawRow[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(spec.columns);
  await target.query(upsertSql(spec, schema, rows.length), rows.flatMap((r) => cols.map((c) => r[c] ?? null)));
}

export const WRITE_BATCH = 1000;
/** Parents first, so foreign keys hold. Full-replace rows are cleared before anything is written. */
export const TABLE_ORDER = ['locations', 'members', 'checkins', 'ezf_active_memberships', 'ezf_active_membership_sync_runs', 'checkin_sync_runs', 'finance_snapshots'];

export function orderedTables(m: Manifest): TableSpec[] {
  const names = m.tables.map((t) => t.table).sort();
  if (JSON.stringify(names) !== JSON.stringify([...TABLE_ORDER].sort())) throw new Error('MANIFEST_TABLE_SET_CHANGED');
  return TABLE_ORDER.map((n) => m.tables.find((t) => t.table === n)!);
}

export type RowSource = (spec: TableSpec) => AsyncIterable<RawRow[]>;
export interface MirrorResult { counts: Record<string, number>; }

/**
 * Writes every table from `source` into `target`. The caller owns the transaction.
 * A full-replace table with zero source rows aborts instead of wiping the target.
 */
export async function runMirror(m: Manifest, source: RowSource, target: Queryable | null, pepper: string): Promise<MirrorResult> {
  assertManifestSafe(m);
  const counts: Record<string, number> = {};
  const schema = m.target.schema;
  for (const spec of orderedTables(m)) {
    let n = 0;
    let cleared = false;
    for await (const page of source(spec)) {
      const rows = page.map((r) => transformRow(spec, r, pepper));
      if (rows.length && spec.mode === 'full_replace' && !cleared && target) {
        await target.query(`delete from "${schema}"."${spec.table}"`);
        cleared = true;
      }
      if (target) for (let i = 0; i < rows.length; i += WRITE_BATCH) await writeBatch(target, spec, schema, rows.slice(i, i + WRITE_BATCH));
      n += rows.length;
    }
    if (spec.mode === 'full_replace' && n === 0) throw new Error(`FULL_REPLACE_EMPTY_SOURCE: ${spec.table}`);
    counts[spec.table] = n;
  }
  return { counts };
}

/** Post-write proof. Counts must match, and no hashed column may hold a non-HMAC value. */
export async function verifyTarget(m: Manifest, target: Queryable, expected: Record<string, number>): Promise<string[]> {
  const problems: string[] = [];
  const schema = m.target.schema;
  for (const spec of orderedTables(m)) {
    const n = (await target.query(`select count(*)::int n from "${schema}"."${spec.table}"`)).rows[0].n as number;
    const want = expected[spec.table] ?? 0;
    if (spec.mode === 'full_replace' ? n !== want : n < want) problems.push(`COUNT_MISMATCH: ${spec.table} target=${n} source=${want}`);
    for (const [col, c] of Object.entries(spec.columns)) {
      if (!c.hash) continue;
      const bad = (await target.query(`select count(*)::int n from "${schema}"."${spec.table}" where "${col}" is not null and "${col}" !~ '^[0-9a-f]{64}$'`)).rows[0].n as number;
      if (bad) problems.push(`UNHASHED: ${spec.table}.${col} rows=${bad}`);
    }
  }
  return problems;
}
