// Brings a database up to the repo: applies supabase/migrations in order, imports the six approved decisions,
// then checks the result. Safe to run again. The governor owns migrations and runs this against Supabase.
//
//   doppler run --project hackathon --config dev -- pnpm exec tsx tools/bootstrap-live.ts --dry-run
//   doppler run --project hackathon --config dev -- pnpm exec tsx tools/bootstrap-live.ts
//
// --dry-run changes nothing and reports what is pending. Exits 1 if any check fails. Never prints the URL.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { pgConfig } from '../src/runner/db';
import { importApproved, loadApprovedPacket } from './import-approved';

/** The part of a connection this tool needs. A pg Client and a PGlite instance both fit. */
export interface Conn {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const SERVICE_ROLES = ['agent_worker', 'evaluator_service', 'gate_service', 'founder_approver', 'dashboard_reader'];
const LOCK_ID = 7204311; // Serializes two bootstraps against the same database.

export interface Check { name: string; ok: boolean; detail?: unknown; }
export interface BootstrapReport {
  dry_run: boolean;
  server: { version: string; user: string; superuser: boolean; tls: boolean | null };
  migrations: { applied: string[]; skipped: string[]; pending: string[] };
  decisions_imported: number | null;
  counts: Record<string, number | null>;
  checks: Check[];
  ok: boolean;
}

async function inTransaction<T>(conn: Conn, fn: () => Promise<T>): Promise<T> {
  await conn.exec('begin');
  try {
    const result = await fn();
    await conn.exec('commit');
    return result;
  } catch (err) {
    await conn.exec('rollback').catch(() => {});
    throw err;
  }
}

/** Kept out of schema public, which PostgREST exposes on Supabase. */
const TRACKING_DDL = `
  create schema if not exists cm_meta;
  create table if not exists cm_meta.applied_migrations (
    filename text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now()
  );`;

async function applied(conn: Conn): Promise<Map<string, string>> {
  const { rows: [t] } = await conn.query(`select to_regclass('cm_meta.applied_migrations') as t`);
  if (!t.t) return new Map();
  const { rows } = await conn.query(`select filename, sha256 from cm_meta.applied_migrations`);
  return new Map(rows.map((r) => [r.filename, r.sha256]));
}

/** Each file and its tracking row land in one transaction. A file edited after it was applied stops everything. */
async function migrate(conn: Conn, dir: string, dryRun: boolean) {
  const result = { applied: [] as string[], skipped: [] as string[], pending: [] as string[] };
  if (!dryRun) await conn.exec(TRACKING_DDL);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    if (dryRun) {
      const known = (await applied(conn)).get(file);
      if (known && known !== hash) throw new Error(`MIGRATION_CHANGED_AFTER_APPLY: ${file}`);
      (known ? result.skipped : result.pending).push(file);
      continue;
    }
    await inTransaction(conn, async () => {
      await conn.query(`select pg_advisory_xact_lock($1)`, [LOCK_ID]);
      const known = (await applied(conn)).get(file);
      if (known && known !== hash) throw new Error(`MIGRATION_CHANGED_AFTER_APPLY: ${file}`);
      if (known) { result.skipped.push(file); return; }
      try {
        await conn.exec(sql);
      } catch (err) {
        throw new Error(`MIGRATION_FAILED: ${file}: ${err instanceof Error ? err.message : err}`);
      }
      await conn.query(`insert into cm_meta.applied_migrations (filename, sha256) values ($1, $2)`, [file, hash]);
      result.applied.push(file);
    });
  }
  return result;
}

async function canTakeRole(conn: Conn, role: string): Promise<boolean> {
  await conn.exec('begin');
  try {
    await conn.exec(`set local role ${role}`);
    const { rows: [r] } = await conn.query(`select current_user as u`);
    return r.u === role;
  } catch {
    return false;
  } finally {
    await conn.exec('rollback');
  }
}

async function countOf(conn: Conn, table: string): Promise<number | null> {
  const { rows: [t] } = await conn.query(`select to_regclass($1) as t`, [table]);
  if (!t.t) return null;
  const { rows: [r] } = await conn.query(`select count(*)::int as n from ${table}`);
  return r.n;
}

async function verify(conn: Conn, packet: ReturnType<typeof loadApprovedPacket>): Promise<{ counts: BootstrapReport['counts']; checks: Check[] }> {
  const checks: Check[] = [];
  for (const role of SERVICE_ROLES) checks.push({ name: `can_set_role:${role}`, ok: await canTakeRole(conn, role) });

  const { rows: [fn] } = await conn.query(`select to_regprocedure('cm.request_completion(uuid)') as gate, to_regprocedure('cm.gate_missing(uuid)') as missing, to_regprocedure('cm.guard_finding()') as finding`);
  checks.push({ name: 'gate_functions_present', ok: Boolean(fn.gate && fn.missing && fn.finding) });

  const ids = packet.bundle.decisions.map((d: { id: string }) => d.id);
  const { rows: decisions } = await conn.query(`select id::text as id, status from cm.decisions where id::text = any($1::text[])`, [ids]);
  // A later correction legitimately supersedes an imported version.
  const live = decisions.filter((d) => d.status === 'accepted' || d.status === 'superseded');
  checks.push({ name: 'approved_decisions_present', ok: live.length === ids.length, detail: `${live.length} of ${ids.length}` });

  const { rows: [scope] } = await conn.query(`
    select count(*) filter (where 'gym_operator' = any(scope))::int as gym_operator,
           count(*) filter (where 'milo_pitch' = any(scope))::int as milo_pitch,
           count(*)::int as drift_reviewer
    from cm.decisions where status = 'accepted'`);
  checks.push({ name: 'accepted_by_profile', ok: scope.gym_operator >= 2 && scope.milo_pitch >= 4 && scope.drift_reviewer >= 6, detail: scope });

  // On Supabase, cm and gym must stay out of reach of the API roles.
  const { rows: api } = await conn.query(`select rolname from pg_roles where rolname in ('anon', 'authenticated')`);
  for (const { rolname } of api) {
    for (const schema of ['cm', 'gym', 'cm_meta']) {
      const { rows: [s] } = await conn.query(`select to_regnamespace($1) is not null as present`, [schema]);
      if (!s.present) continue;
      const { rows: [p] } = await conn.query(`select has_schema_privilege($1, $2, 'usage') as can`, [rolname, schema]);
      checks.push({ name: `not_exposed:${schema}:${rolname}`, ok: !p.can });
    }
  }

  const counts: BootstrapReport['counts'] = {};
  for (const table of ['cm.sources', 'cm.decisions', 'cm.runs', 'cm.gate_decisions', 'cm.findings', 'gym.locations', 'gym.members', 'gym.mirror_runs']) counts[table] = await countOf(conn, table);
  return { counts, checks };
}

export async function bootstrap(conn: Conn, opts: { root: string; dryRun?: boolean }): Promise<BootstrapReport> {
  const dryRun = opts.dryRun ?? false;
  const { rows: [s] } = await conn.query(`select current_setting('server_version') as version, current_user as usr, (select rolsuper from pg_roles where rolname = current_user) as superuser`);
  const { rows: [tls] } = await conn.query(`select ssl from pg_stat_ssl where pid = pg_backend_pid()`);
  const server = { version: s.version, user: s.usr, superuser: s.superuser, tls: tls?.ssl ?? null };

  // The approved packet is checked before anything is written, so a tampered bundle stops the run.
  const packet = loadApprovedPacket(opts.root);
  const migrations = await migrate(conn, `${opts.root}supabase/migrations`, dryRun);
  if (dryRun) return { dry_run: true, server, migrations, decisions_imported: null, counts: {}, checks: [], ok: true };

  const decisions_imported = await inTransaction(conn, () => importApproved(conn, packet));
  const { counts, checks } = await verify(conn, packet);
  return { dry_run: false, server, migrations, decisions_imported, counts, checks, ok: checks.every((c) => c.ok) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new pg.Client(pgConfig());
  try {
    await client.connect();
    const conn: Conn = { exec: (sql) => client.query(sql), query: (sql, params) => client.query(sql, params as any[]) };
    const report = await bootstrap(conn, { root: new URL('..', import.meta.url).pathname, dryRun: process.argv.includes('--dry-run') });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}
