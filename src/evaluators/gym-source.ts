import type { GymSource } from './gym';

export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; }

/**
 * Evaluator-side reader over the source projection (or its mirror). Mirrors owner-membership.ts: the latest run per
 * location must itself be complete, otherwise that location has no trustworthy position. Returns dates and counts only.
 */
export function createPgGymSource(db: Queryable, opts: { schema?: string } = {}): GymSource {
  const schema = opts.schema ?? 'public';
  if (!/^[A-Za-z_][\w]*$/.test(schema)) throw new Error('Invalid schema name');
  const latest = `(
    select distinct on (location_id) location_id, status, report_as_of
    from "${schema}".ezf_active_membership_sync_runs
    order by location_id, started_at desc
  ) r`;
  return {
    async dataAsOf() {
      const { rows } = await db.query(`select r.location_id, r.report_as_of::text as report_as_of from ${latest} where r.status = 'complete' and r.report_as_of is not null`);
      return Object.fromEntries(rows.map((x) => [x.location_id, x.report_as_of]));
    },
    async canonicalCounts() {
      const { rows } = await db.query(
        `select r.location_id, count(m.*)::int as n
         from ${latest}
         left join "${schema}".ezf_active_memberships m on m.location_id = r.location_id and m.bridge_class = 'MATCHED_INDIVIDUAL'
         where r.status = 'complete'
         group by r.location_id`);
      return Object.fromEntries(rows.map((x) => [x.location_id, x.n]));
    },
  };
}
