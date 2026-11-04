import type { GymSource } from './gym';

export interface Queryable { query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; }

/**
 * Evaluator-side reader over the source projection (or its mirror). Reads the latest complete run per location, as the
 * accepted decision gym.active_individual_definition says. A later failed or stuck run does not replace that
 * projection, so its report date stays what freshness must report (east3 is 2026-10-01 for this reason).
 * Returns dates and counts only.
 */
export function createPgGymSource(db: Queryable, opts: { schema?: string } = {}): GymSource {
  const schema = opts.schema ?? 'public';
  if (!/^[A-Za-z_][\w]*$/.test(schema)) throw new Error('Invalid schema name');
  const latest = `(
    select distinct on (location_id) location_id, status, report_as_of
    from "${schema}".ezf_active_membership_sync_runs
    where status = 'complete'
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
