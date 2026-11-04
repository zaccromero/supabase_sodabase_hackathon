import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { activeMemberPosition, dataAgeDays } from '../src/data/active-members';

const sql = (f: string) => readFileSync(new URL(`../supabase/migrations/${f}`, import.meta.url), 'utf8');
const NOW = new Date('2026-11-04T22:00:00Z');
const H = (c: string) => c.repeat(64);
let db: PGlite;
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const loc = (l: string) => db.query(`insert into gym.locations (id) values ($1)`, [l]);
async function member(l: string, churned: string | null = null) {
  const m = id();
  await db.query(`insert into gym.members (id, location_id, joined_at, churned_at) values ($1,$2,'2025-01-01',$3)`, [m, l, churned]);
  return m;
}
let key = 0;
async function row(l: string, cls: string, m: string | null, asOf = '2026-11-03') {
  const k = (++key).toString(16).padStart(64, '0');
  await db.query(
    `insert into gym.ezf_active_memberships (id, location_id, source_membership_key, ezf_membership_number, member_id, membership_mode, membership_start, membership_end, bridge_class, report_as_of, source_csv_sha256, source_last_seen_at, ingested_at, updated_at)
     values ($1,$2,$3,$4,$5,'x','2026-01-01','2026-12-31',$6,$7,$8,now(),now(),now())`,
    [id(), l, k, H('a'), m, cls, asOf, H('c')],
  );
}
interface Run { status?: string; asOf?: string | null; started?: string; finished?: string | null; total?: number; keys?: number; active?: number; excl?: number; }
const run = (l: string, r: Run = {}) => {
  const status = r.status ?? 'complete';
  const total = r.total ?? 0;
  const active = r.active ?? total;
  return db.query(
    `insert into gym.ezf_active_membership_sync_runs (id, location_id, report_as_of, report_filter_version, started_at, finished_at, source_rows_total, unique_membership_keys, active_individual_members, explained_exclusions, structural_differences, unmapped_members, unexplained_records, status, had_errors, parse_drift)
     values ($1,$2,$3,'v',$4,$5,$6,$7,$8,$9,0,0,0,$10,false,false)`,
    [id(), l, r.asOf === undefined ? '2026-11-03' : r.asOf, r.started ?? '2026-11-04T08:00:00Z', r.finished === undefined ? '2026-11-04T08:05:00Z' : r.finished, total, r.keys ?? total, active, r.excl ?? total - active, status],
  );
};
const position = () => activeMemberPosition(db, NOW);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(sql('001_core.sql'));
  await db.exec(sql('002_gym.sql'));
});

describe('canonical active members', () => {
  it('counts MATCHED_INDIVIDUAL only and shows the churned_at gap as not canonical', async () => {
    await loc('lex');
    const a = await member('lex');
    const b = await member('lex');
    await member('lex');
    await row('lex', 'MATCHED_INDIVIDUAL', a);
    await row('lex', 'EXCLUDED_CORPORATE', b);
    await row('lex', 'MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT', a);
    await run('lex', { total: 3, active: 1 });
    const p = await position();
    const l = p.locations[0]!;
    expect(l.state).toBe('RECONCILED');
    expect(l.active_individual_members).toBe(1);
    expect(l.not_canonical_churned_at_null).toBe(3);
    expect(l).not.toHaveProperty('not_current_last_complete');
    expect(p.total_active_individual_members).toBe(1);
  });
  it('reports the source date, fetch time and age, and labels old data stale', async () => {
    await loc('lex');
    await row('lex', 'MATCHED_INDIVIDUAL', await member('lex'), '2026-10-05');
    await run('lex', { total: 1, asOf: '2026-10-05', started: '2026-10-05T08:00:00Z', finished: '2026-10-05T08:36:24Z' });
    const l = (await position()).locations[0]!;
    expect(l.state).toBe('STALE');
    expect(l.active_individual_members).toBe(1);
    expect(l.report_as_of).toBe('2026-10-05');
    expect(l.fetched_at).toBe('2026-10-05T08:36:24.000Z');
    expect(l.data_age_days).toBe(30);
  });
  it('reports unknown, never zero, for a location with no run', async () => {
    await loc('mul');
    const p = await position();
    expect(p.locations[0]).toMatchObject({ state: 'UNKNOWN', active_individual_members: null, problems: ['NO_SYNC_RUN'] });
    expect(p.total_active_individual_members).toBeNull();
    expect(p.state).toBe('UNKNOWN');
  });
  it('reports partial, never zero, when the latest run failed, even after an earlier complete run', async () => {
    await loc('bk');
    await row('bk', 'MATCHED_INDIVIDUAL', await member('bk'));
    await run('bk', { total: 1, started: '2026-11-03T08:00:00Z', finished: '2026-11-03T08:05:00Z' });
    await run('bk', { status: 'failed', asOf: null, started: '2026-11-04T08:00:00Z', finished: null });
    const p = await position();
    expect(p.locations[0]).toMatchObject({ state: 'PARTIAL', active_individual_members: null, problems: ['LATEST_RUN_FAILED'] });
    expect(p.locations[0]!.not_current_last_complete).toMatchObject({ report_as_of: '2026-11-03', active_individual_members: 1, rows_match_table: true });
    expect(p.total_active_individual_members).toBeNull();
  });
  it('reports partial when a complete run does not reconcile with its rows', async () => {
    await loc('lex');
    await row('lex', 'MATCHED_INDIVIDUAL', await member('lex'));
    await run('lex', { total: 2, active: 2 });
    const l = (await position()).locations[0]!;
    expect(l.state).toBe('PARTIAL');
    expect(l.active_individual_members).toBeNull();
    expect(l.problems).toEqual(expect.arrayContaining(['ROW_COUNT_MISMATCH', 'KEY_COUNT_MISMATCH', 'MATCHED_COUNT_MISMATCH']));
  });
  it('reports partial when rows carry another report date', async () => {
    await loc('lex');
    await row('lex', 'MATCHED_INDIVIDUAL', await member('lex'), '2026-11-01');
    await run('lex', { total: 1 });
    expect((await position()).locations[0]!.problems).toEqual(['REPORT_DATE_MISMATCH']);
  });
  it('withholds the total when any location is unusable, and keeps the good count', async () => {
    await loc('lex');
    await loc('mul');
    await row('lex', 'MATCHED_INDIVIDUAL', await member('lex'));
    await run('lex', { total: 1 });
    const p = await position();
    expect(p.locations.find((l) => l.location_id === 'lex')!.active_individual_members).toBe(1);
    expect(p.total_active_individual_members).toBeNull();
  });
  it('allows a true zero only from a complete, reconciled, empty projection', async () => {
    await loc('lex');
    await run('lex', { total: 0 });
    expect((await position()).locations[0]).toMatchObject({ state: 'RECONCILED', active_individual_members: 0 });
  });
  it('runs for a read-only reader and returns no member identifiers', async () => {
    await loc('lex');
    await row('lex', 'MATCHED_INDIVIDUAL', await member('lex'));
    await run('lex', { total: 1 });
    await db.exec('set role dashboard_reader');
    try {
      const p = await position();
      expect(JSON.stringify(p)).not.toMatch(/[0-9a-f]{64}|00000000-0000-4000/);
    } finally { await db.exec('reset role'); }
  });
  it('counts age in New York days', () => {
    expect(dataAgeDays('2026-11-03', new Date('2026-11-05T03:00:00Z'))).toBe(1);
    expect(dataAgeDays('2026-11-03', new Date('2026-11-05T06:00:00Z'))).toBe(2);
  });
});
