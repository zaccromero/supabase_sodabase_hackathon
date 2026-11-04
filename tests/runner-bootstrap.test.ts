import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { pgConfig } from '../src/runner/db';
import { bootstrap, type Conn } from '../tools/bootstrap-live';

const root = new URL('..', import.meta.url).pathname;
let raw: PGlite;
let conn: Conn;

beforeEach(() => {
  raw = new PGlite();
  conn = { exec: (sql) => raw.exec(sql), query: (sql, params) => raw.query(sql, params) as any };
});

describe('bootstrap', () => {
  it('applies migrations in order, imports the six decisions, and passes its checks', async () => {
    const report = await bootstrap(conn, { root });
    expect(report.migrations.applied).toEqual(['001_core.sql', '002_gym.sql', '003_runner_roles.sql']);
    expect(report.decisions_imported).toBe(6);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts['cm.decisions']).toBe(6);
    expect(report.checks.find((c) => c.name === 'accepted_by_profile')!.detail).toEqual({ gym_operator: 2, milo_pitch: 4, drift_reviewer: 6 });
    const { rows } = await raw.query<{ accepted_by: string }>(`select distinct accepted_by from cm.decisions`);
    expect(rows).toEqual([{ accepted_by: 'Zacc Romero' }]);
  });

  it('running again changes nothing', async () => {
    await bootstrap(conn, { root });
    const again = await bootstrap(conn, { root });
    expect(again.migrations.applied).toEqual([]);
    expect(again.migrations.skipped).toHaveLength(3);
    expect(again.counts['cm.decisions']).toBe(6);
    expect(again.ok).toBe(true);
  });

  it('a dry run reports what is pending and writes nothing', async () => {
    const report = await bootstrap(conn, { root, dryRun: true });
    expect(report.migrations.pending).toHaveLength(3);
    const { rows } = await raw.query<{ a: unknown; b: unknown }>(`select to_regnamespace('cm') as a, to_regnamespace('cm_meta') as b`);
    expect(rows[0]).toEqual({ a: null, b: null });
  });

  it('stops if an applied migration was edited afterwards', async () => {
    await bootstrap(conn, { root });
    await raw.exec(`update cm_meta.applied_migrations set sha256 = 'different' where filename = '002_gym.sql'`);
    await expect(bootstrap(conn, { root })).rejects.toThrow(/MIGRATION_CHANGED_AFTER_APPLY: 002_gym.sql/);
    await expect(bootstrap(conn, { root, dryRun: true })).rejects.toThrow(/MIGRATION_CHANGED_AFTER_APPLY/);
  });

  it('a failing migration rolls back whole, names the file, and leaves no tracking row', async () => {
    await raw.exec(`create schema gym; create table gym.locations (id text primary key)`);
    await expect(bootstrap(conn, { root })).rejects.toThrow(/MIGRATION_FAILED: 002_gym.sql/);
    const { rows } = await raw.query<{ filename: string }>(`select filename from cm_meta.applied_migrations order by 1`);
    expect(rows).toEqual([{ filename: '001_core.sql' }]);
    expect((await raw.query(`select count(*)::int n from pg_tables where schemaname = 'gym'`)).rows).toEqual([{ n: 1 }]);
  });

  it('flags a schema the Supabase API roles can reach', async () => {
    await raw.exec(`create role anon nologin`);
    await bootstrap(conn, { root });
    await raw.exec(`grant usage on schema cm to anon`);
    const report = await bootstrap(conn, { root });
    expect(report.ok).toBe(false);
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['not_exposed:cm:anon']);
  });
});

describe('connection settings', () => {
  const remote = 'postgres://u:secret@db.example.com:5432/postgres';

  it('refuses to send a password to a remote host without TLS, and does not repeat the URL', () => {
    for (const url of [remote, `${remote}?sslmode=disable`]) {
      expect(() => pgConfig(url, '')).toThrow(/TLS_REQUIRED/);
      try { pgConfig(url, ''); } catch (err) { expect(String(err)).not.toContain('secret'); }
    }
  });

  it('a CA replaces any sslmode, so the CA is what gets verified', () => {
    const config = pgConfig(`${remote}?sslmode=require`, 'CA-PEM');
    expect(config.ssl).toEqual({ ca: 'CA-PEM' });
    expect(config.connectionString).not.toContain('sslmode');
  });

  it('keeps an explicit sslmode, and allows a local database without TLS', () => {
    expect(pgConfig(`${remote}?sslmode=verify-full`, '').connectionString).toContain('sslmode=verify-full');
    expect(pgConfig('postgres://postgres@127.0.0.1:5432/postgres', '').ssl).toBeUndefined();
  });
});
