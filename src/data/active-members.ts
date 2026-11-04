// Canonical active individual members per location, from the mirrored gym tables.
// Follows gym-nyc apps/web/lib/db/queries/owner-membership.ts and accepted decisions
// gym.active_individual_definition and gym.freshness_completeness.
//   pnpm tsx src/data/active-members.ts              print counts
//   pnpm tsx src/data/active-members.ts --receipt    also write docs/receipts/gym-active-members-*.json
// Read-only. Output is counts and dates per location, never a member row.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sha256 } from '../contract/hash';
import type { Queryable } from './mirror-core';

export const FRESHNESS_HOURS = 26;
export type PositionState = 'RECONCILED' | 'STALE' | 'PARTIAL' | 'UNKNOWN';

export const ACTIVE_MEMBERS_SQL = `
with latest as (
  select distinct on (location_id)
    location_id, status, report_as_of::text as report_as_of, finished_at, source_rows_total,
    unique_membership_keys, active_individual_members, unmapped_members, unexplained_records, error_code
  from gym.ezf_active_membership_sync_runs
  order by location_id, started_at desc
), last_complete as (
  select distinct on (location_id)
    location_id, report_as_of::text as report_as_of, finished_at, active_individual_members, source_rows_total
  from gym.ezf_active_membership_sync_runs
  where status = 'complete'
  order by location_id, started_at desc
), projection as (
  select location_id,
    count(*)::int as projected_rows,
    count(distinct source_membership_key)::int as unique_keys,
    count(*) filter (where bridge_class = 'MATCHED_INDIVIDUAL')::int as matched_individual,
    count(distinct member_id) filter (where bridge_class = 'MATCHED_INDIVIDUAL')::int as matched_distinct_members,
    min(report_as_of)::text as min_report_as_of,
    max(report_as_of)::text as max_report_as_of
  from gym.ezf_active_memberships
  group by location_id
), naive as (
  select location_id, count(*)::int as churned_at_null
  from gym.members
  where churned_at is null
  group by location_id
)
select l.id as location_id,
  r.status as latest_run_status, r.report_as_of, r.finished_at as fetched_at, r.source_rows_total,
  r.unique_membership_keys, r.active_individual_members as run_active_individual_members,
  r.unmapped_members, r.unexplained_records, r.error_code as latest_run_error_code,
  c.report_as_of as last_complete_report_as_of, c.finished_at as last_complete_fetched_at,
  c.active_individual_members as last_complete_active, c.source_rows_total as last_complete_rows,
  coalesce(p.projected_rows, 0) as projected_rows, coalesce(p.unique_keys, 0) as unique_keys,
  coalesce(p.matched_individual, 0) as matched_individual,
  coalesce(p.matched_distinct_members, 0) as matched_distinct_members,
  p.min_report_as_of, p.max_report_as_of,
  coalesce(n.churned_at_null, 0) as churned_at_null
from gym.locations l
left join latest r on r.location_id = l.id
left join last_complete c on c.location_id = l.id
left join projection p on p.location_id = l.id
left join naive n on n.location_id = l.id
order by l.id`;

export interface LocationPosition {
  location_id: string;
  state: PositionState;
  /** Null unless the projection reconciles. Never a stand-in zero. */
  active_individual_members: number | null;
  report_as_of: string | null;
  fetched_at: string | null;
  data_age_days: number | null;
  fetch_age_hours: number | null;
  problems: string[];
  checks: { projected_rows: number; source_rows_total: number | null; matched_distinct_members: number };
  /** The wrong answer the definition rules out, kept so a demo can show the gap. */
  not_canonical_churned_at_null: number;
  /**
   * Only on an unusable location. The earlier projection, for explaining the gap.
   * It is not the location's current count and is never added to a total.
   */
  not_current_last_complete?: { report_as_of: string; fetched_at: string; active_individual_members: number; rows_match_table: boolean } | null;
  latest_run_error_code?: string | null;
}
export interface Position {
  state: PositionState;
  /** Null if any location lacks a count, so a partial sum can never pass as a total. */
  total_active_individual_members: number | null;
  oldest_report_as_of: string | null;
  locations: LocationPosition[];
}

/** Whole days from the report date to today in New York, where the gyms report. */
export function dataAgeDays(reportAsOf: string, now: Date): number {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${reportAsOf}T00:00:00Z`)) / 86_400_000);
}

export function classifyLocation(r: Record<string, any>, now: Date): LocationPosition {
  const base = {
    location_id: r.location_id as string,
    checks: { projected_rows: r.projected_rows as number, source_rows_total: (r.source_rows_total ?? null) as number | null, matched_distinct_members: r.matched_distinct_members as number },
    not_canonical_churned_at_null: r.churned_at_null as number,
  };
  const reportAsOf: string | null = r.report_as_of ?? null;
  const fetched: Date | null = r.fetched_at ? new Date(r.fetched_at) : null;
  const unusable = (state: PositionState, problems: string[]): LocationPosition => ({
    ...base, state, active_individual_members: null, problems,
    latest_run_error_code: r.latest_run_error_code ?? null,
    not_current_last_complete: r.last_complete_report_as_of ? {
      report_as_of: r.last_complete_report_as_of,
      fetched_at: new Date(r.last_complete_fetched_at).toISOString(),
      active_individual_members: r.last_complete_active,
      rows_match_table: r.last_complete_rows === r.projected_rows && r.last_complete_active === r.matched_individual,
    } : null,
    report_as_of: reportAsOf, fetched_at: fetched?.toISOString() ?? null,
    data_age_days: reportAsOf ? dataAgeDays(reportAsOf, now) : null,
    fetch_age_hours: fetched ? Math.floor((now.getTime() - fetched.getTime()) / 3_600_000) : null,
  });

  if (!r.latest_run_status) return unusable('UNKNOWN', ['NO_SYNC_RUN']);
  if (r.latest_run_status !== 'complete') return unusable('PARTIAL', [`LATEST_RUN_${String(r.latest_run_status).toUpperCase()}`]);
  if (!fetched || !reportAsOf) return unusable('PARTIAL', ['RUN_MISSING_DATES']);

  const problems: string[] = [];
  if (r.projected_rows !== r.source_rows_total) problems.push('ROW_COUNT_MISMATCH');
  if (r.unique_keys !== r.unique_membership_keys) problems.push('KEY_COUNT_MISMATCH');
  if (r.matched_individual !== r.run_active_individual_members) problems.push('MATCHED_COUNT_MISMATCH');
  if (r.unmapped_members !== 0 || r.unexplained_records !== 0) problems.push('UNEXPLAINED_RECORDS');
  if (r.projected_rows > 0 && (r.min_report_as_of !== reportAsOf || r.max_report_as_of !== reportAsOf)) problems.push('REPORT_DATE_MISMATCH');
  if (problems.length) return unusable('PARTIAL', problems);

  const stale = now.getTime() - fetched.getTime() > FRESHNESS_HOURS * 3_600_000;
  const { not_current_last_complete: _earlier, latest_run_error_code: _code, ...usable } = unusable(stale ? 'STALE' : 'RECONCILED', []);
  return { ...usable, active_individual_members: r.matched_individual as number };
}

export function summarize(rows: Array<Record<string, any>>, now: Date): Position {
  const locations = rows.map((r) => classifyLocation(r, now));
  const dates = locations.map((l) => l.report_as_of).filter((d): d is string => !!d).sort();
  const incomplete = locations.length === 0 || locations.some((l) => l.active_individual_members === null);
  const state: PositionState = locations.length === 0 || locations.some((l) => l.state === 'UNKNOWN') ? 'UNKNOWN'
    : locations.some((l) => l.state === 'PARTIAL') ? 'PARTIAL'
    : locations.some((l) => l.state === 'STALE') ? 'STALE' : 'RECONCILED';
  return {
    state,
    total_active_individual_members: incomplete ? null : locations.reduce((s, l) => s + (l.active_individual_members ?? 0), 0),
    oldest_report_as_of: dates[0] ?? null,
    locations,
  };
}

export async function activeMemberPosition(db: Queryable, now = new Date()): Promise<Position> {
  return summarize((await db.query(ACTIVE_MEMBERS_SQL)).rows, now);
}

async function cli() {
  let url: string | undefined;
  try { url = execFileSync('doppler', ['--no-check-version', 'secrets', 'get', 'SUPABASE_DB_URL', '--plain', '-p', 'hackathon', '-c', 'dev'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { /* reported below */ }
  if (!url) { console.error('BLOCKED: SUPABASE_DB_URL missing from Doppler hackathon/dev'); process.exit(2); }
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    await client.query('BEGIN TRANSACTION READ ONLY');
    if ((await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only !== 'on') throw new Error('NOT_READ_ONLY');
    const now = new Date();
    const position = await activeMemberPosition(client, now);
    const mirror = (await client.query(`select finished_at, manifest_sha256, source_label from gym.mirror_runs order by finished_at desc limit 1`)).rows[0];
    await client.query('ROLLBACK');
    const receipt = {
      kind: 'gym_active_members', provenance: 'real', observed_at: now.toISOString(),
      database: 'supabase schema gym, read-only transaction',
      definition: 'gym.active_individual_definition v1, gym.freshness_completeness v1',
      logic_source: 'projects/gym-nyc@9cbef1f858d9/apps/web/lib/db/queries/owner-membership.ts:L92-L129',
      query: 'src/data/active-members.ts ACTIVE_MEMBERS_SQL', query_sha256: sha256(ACTIVE_MEMBERS_SQL),
      latest_mirror: mirror ? { finished_at: new Date(mirror.finished_at).toISOString(), manifest_sha256: mirror.manifest_sha256, source: mirror.source_label } : null,
      ...position,
    };
    console.log(JSON.stringify(receipt, null, 2));
    if (process.argv.includes('--receipt')) {
      const path = new URL(`../../docs/receipts/gym-active-members-${now.toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
      writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`);
    }
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli().catch((e) => { console.error(`ACTIVE_MEMBERS_FAILED ${e?.code ?? String(e?.message ?? e).slice(0, 80)}`); process.exit(1); });
}
