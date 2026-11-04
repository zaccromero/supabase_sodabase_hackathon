import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const request = read('docs/migration-requests/gym-indexes.sql');
let db: PGlite;

/** With sequential scans priced out, the plan shows whether an index fits the query's shape at all. */
const usesIndex = async (sql: string, index: string) => {
  await db.exec('set enable_seqscan = off');
  const plan = JSON.stringify((await db.query(`explain (format json) ${sql}`)).rows);
  return plan.includes(index);
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(read('supabase/migrations/001_core.sql'));
  await db.exec(read('supabase/migrations/002_gym.sql'));
  await db.exec(request);
});

describe('requested gym indexes', () => {
  it('apply cleanly and can be applied twice', async () => {
    await expect(db.exec(request)).resolves.toBeDefined();
  });
  it('are all in schema gym and create nothing else', () => {
    const statements = request.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(5);
    for (const s of statements) expect(s).toMatch(/^create index if not exists \w+\s+on gym\./);
  });
  it.each([
    ['amsr_location_started_idx', `select distinct on (location_id) location_id, status from gym.ezf_active_membership_sync_runs order by location_id, started_at desc`],
    ['amsr_complete_location_started_idx', `select distinct on (location_id) location_id, report_as_of from gym.ezf_active_membership_sync_runs where status = 'complete' order by location_id, started_at desc`],
    ['checkins_time_idx', `select max(checked_in_at) from gym.checkins`],
    ['finance_location_date_idx', `select distinct on (location_id) location_id, active_members from gym.finance_snapshots order by location_id, snapshot_date desc`],
    ['members_location_churned_idx', `select location_id, count(*) from gym.members where churned_at is null group by 1`],
  ])('%s fits the query it was requested for', async (index, sql) => {
    expect(await usesIndex(sql, index)).toBe(true);
  });
});
