#!/usr/bin/env tsx
// Mirrors allowlisted, pseudonymised Gym NYC DEV rows from Neon into Supabase schema gym.
//   pnpm tsx tools/mirror.ts --dry-run        counts and PII scan, writes nothing
//   pnpm tsx tools/mirror.ts --pglite-check   real rows through the real DDL in memory, nothing persists
//   pnpm tsx tools/mirror.ts                  writes to SUPABASE_DB_URL
// Prints counts and column names only. Never a row, value or secret.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  assertManifestSafe, countSql, loadManifest, manifestSha256, orderedTables, runMirror, selectSql, verifyTarget,
  type Manifest, type Queryable, type RawRow, type RowSource,
} from '../src/data/mirror-core';

const PAGE = 2000;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const pgliteCheck = args.has('--pglite-check');
const targetSslNoVerify = args.has('--target-ssl-no-verify');

function dopplerSecret(project: string, config: string, name: string): string | undefined {
  try {
    const v = execFileSync('doppler', ['--no-check-version', 'secrets', 'get', name, '--plain', '-p', project, '-c', config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return v || undefined;
  } catch { return undefined; }
}

function blocked(what: string): never {
  console.error(`BLOCKED: ${what}`);
  process.exit(2);
}

/** Source comes only from the manifest's Doppler config, which must be dev. There is no override. */
function sourceUrl(m: Manifest): string {
  if (m.source.doppler_config !== 'dev') throw new Error('SOURCE_MUST_BE_DEV');
  const url = dopplerSecret(m.source.doppler_project, m.source.doppler_config, 'DATABASE_URL');
  if (!url) blocked(`DATABASE_URL not readable from Doppler ${m.source.doppler_project}/${m.source.doppler_config}`);
  return url;
}

function targetClient(url: string, source: string): pg.Client {
  const host = new URL(url).hostname;
  if (host === new URL(source).hostname) throw new Error('TARGET_IS_SOURCE');
  if (/neon\.tech$/.test(host)) throw new Error('TARGET_IS_NEON');
  if (!/(supabase\.(co|com)|^localhost|^127\.0\.0\.1)$/.test(host)) throw new Error('TARGET_NOT_SUPABASE');
  if (!targetSslNoVerify) return new pg.Client({ connectionString: url });
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false } });
}

/** Every value arrives as text, in UTC, so nothing is reinterpreted on the way through. */
async function openSource(m: Manifest) {
  const url = sourceUrl(m);
  const client = new pg.Client({ connectionString: url, types: { getTypeParser: () => (v: string) => v } as any });
  await client.connect();
  await client.query('SET default_transaction_read_only = on');
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL TIME ZONE 'UTC'`);
  const ro = (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
  if (ro !== 'on') throw new Error('SOURCE_NOT_READ_ONLY');
  const rows: RowSource = async function* (spec) {
    const cursor = `mirror_${spec.table}`;
    await client.query(`DECLARE ${cursor} NO SCROLL CURSOR FOR ${selectSql(spec, m.source.schema)}`);
    for (;;) {
      const r = await client.query(`FETCH ${PAGE} FROM ${cursor}`);
      if (r.rows.length === 0) break;
      yield r.rows as RawRow[];
    }
    await client.query(`CLOSE ${cursor}`);
  };
  return { url, client, rows, close: async () => { await client.query('ROLLBACK'); await client.end(); } };
}

/** Source columns the allowlist drops, by count. Metadata only. */
async function droppedColumnCounts(client: pg.Client, m: Manifest): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const spec of m.tables) {
    const r = await client.query(`select column_name from information_schema.columns where table_schema = $1 and table_name = $2`, [m.source.schema, spec.table]);
    const present = new Set(r.rows.map((x) => x.column_name as string));
    for (const c of Object.keys(spec.columns)) if (!present.has(c)) throw new Error(`SOURCE_COLUMN_MISSING: ${spec.table}.${c}`);
    out[spec.table] = present.size - Object.keys(spec.columns).length;
  }
  return out;
}

async function pgliteTarget(): Promise<Queryable & { exec(s: string): Promise<unknown> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../docs/migration-requests/002_gym.sql', import.meta.url), 'utf8'));
  return db as any;
}

async function main() {
  const m = loadManifest();
  assertManifestSafe(m);
  const startedAt = new Date().toISOString();
  const pepper = dopplerSecret('hackathon', 'dev', 'GYM_MIRROR_PEPPER');
  const targetUrl = dopplerSecret('hackathon', 'dev', 'SUPABASE_DB_URL');

  if (!dryRun && !pgliteCheck) {
    const missing = [!pepper && 'GYM_MIRROR_PEPPER', !targetUrl && 'SUPABASE_DB_URL'].filter(Boolean);
    if (missing.length) blocked(`${missing.join(' and ')} missing from Doppler hackathon/dev`);
  }
  // A throwaway pepper is enough to prove every row transforms. Nothing it hashes is stored.
  const usePepper = (dryRun || pgliteCheck) ? (pepper ?? randomBytes(32).toString('hex')) : pepper!;

  const src = await openSource(m);
  let target: pg.Client | null = null;
  try {
    const dropped = await droppedColumnCounts(src.client, m);
    const sourceCounts: Record<string, number> = {};
    for (const spec of orderedTables(m)) sourceCounts[spec.table] = (await src.client.query(countSql(spec, m.source.schema))).rows[0].n;

    if (dryRun) {
      const { counts } = await runMirror(m, src.rows, null, usePepper);
      for (const spec of orderedTables(m)) {
        const hashed = Object.values(spec.columns).filter((c) => c.hash).length;
        console.log(`${spec.table}: source=${sourceCounts[spec.table]} transformed=${counts[spec.table]} allowlisted=${Object.keys(spec.columns).length} hashed=${hashed} dropped=${dropped[spec.table]} mode=${spec.mode}`);
      }
      console.log(`DRY_RUN_OK manifest=${manifestSha256().slice(0, 12)} pepper=${pepper ? 'doppler' : 'ephemeral'} writes=0`);
      return;
    }

    if (pgliteCheck) {
      const db = await pgliteTarget();
      await db.exec('begin');
      const { counts } = await runMirror(m, src.rows, db, usePepper);
      await db.exec('commit');
      const problems = await verifyTarget(m, db, counts);
      for (const [t, n] of Object.entries(counts)) console.log(`${t}: mirrored=${n}`);
      if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; return; }
      console.log('PGLITE_CHECK_OK real rows passed the gym DDL, nothing persisted');
      return;
    }

    target = targetClient(targetUrl!, src.url);
    await target.connect();
    await target.query('BEGIN');
    const { counts } = await runMirror(m, src.rows, target, usePepper);
    const problems = await verifyTarget(m, target, counts);
    if (problems.length) throw new Error(problems.join('; '));
    await target.query(
      `insert into gym.mirror_runs (started_at, finished_at, manifest_sha256, source_label, table_counts) values ($1, now(), $2, $3, $4)`,
      [startedAt, manifestSha256(), `${m.source.doppler_project}/${m.source.doppler_config}`, JSON.stringify(counts)],
    );
    await target.query('COMMIT');
    for (const [t, n] of Object.entries(counts)) console.log(`${t}: mirrored=${n}`);
    console.log('MIRROR_OK');
  } catch (e) {
    if (target) await target.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await src.close();
    if (target) await target.end();
  }
}

main().catch((e) => {
  // Driver errors can quote row values, so only codes, constraints and our own markers print.
  const msg = String(e?.message ?? e);
  const safe = /^[A-Z_]+(:|$)/.test(msg) ? msg : `${e?.code ?? 'ERROR'} ${e?.constraint ?? ''} ${e?.table ?? ''}`.trim();
  console.error(`MIRROR_FAILED ${safe}`);
  process.exit(1);
});
