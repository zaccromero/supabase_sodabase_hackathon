import { dbMode, withRole } from '@/lib/db';

const REVIEWED_MIRROR = 'c08024fa-3825-4c69-96b9-d9a83e08703b';
export const MEMBER_EXPIRATION_AGGREGATE_SQL = `
select count(*)::text as total,
 count(*) filter (where v.quarantined)::text as quarantined,
 count(*) filter (where v.quarantined and v.normalized_expiration_date is null)::text as normalized_unknown,
 count(*) filter (where v.quarantined and
   (v.source_expiration_date at time zone 'America/New_York')::date
   in (date '1980-06-30',date '1980-12-31'))::text as original_placeholders_retained,
 bool_and(v.source_expiration_date is not distinct from m.expiration_date) as raw_values_preserved,
 count(*) = (select count(*) from gym.members) as population_preserved,
 bool_and(v.mirror_run_id = $1::uuid) as reviewed_mirror
from gym.v_member_expiration_review v
left join gym.members m on m.id = v.source_member_id`;

type Counts = { total: number; quarantined: number; normalized_unknown: number; original_placeholders_retained: number; raw_values_preserved: boolean; population_preserved: boolean; reviewed_mirror: boolean };
export async function readMemberExpirationReview(): Promise<{ status: 'verified' | 'review'; counts: Counts } | { status: 'not-installed' | 'unavailable' }> {
  if (dbMode() !== 'live') return { status: 'unavailable' };
  try {
    const rows = await withRole('dashboard_reader', (tx) => tx.query<Record<string, unknown>>(MEMBER_EXPIRATION_AGGREGATE_SQL, [REVIEWED_MIRROR]));
    const row = rows[0];
    if (!row) return { status: 'unavailable' };
    const values = ['total', 'quarantined', 'normalized_unknown', 'original_placeholders_retained'] as const;
    const counts = {} as Counts;
    for (const key of values) {
      const value = Number(row[key]);
      if ((typeof row[key] !== 'string' && typeof row[key] !== 'number') || !Number.isSafeInteger(value) || value < 0) return { status: 'unavailable' };
      counts[key] = value;
    }
    counts.raw_values_preserved = row.raw_values_preserved === true;
    counts.population_preserved = row.population_preserved === true;
    counts.reviewed_mirror = row.reviewed_mirror === true;
    const verified = counts.total > 0 && counts.quarantined === 2 && counts.normalized_unknown === 2 && counts.original_placeholders_retained === 2 && counts.raw_values_preserved && counts.population_preserved && counts.reviewed_mirror;
    return { status: verified ? 'verified' : 'review', counts };
  } catch (error) {
    return { status: (error as { code?: string }).code === '42P01' ? 'not-installed' : 'unavailable' };
  }
}

export async function MemberExpirationReview() {
  const result = await readMemberExpirationReview();
  return <section aria-labelledby="q-expiration-review">
    <header className="section-head"><h2 className="question" id="q-expiration-review">What changed in the two date records?</h2><p className="age">Derived analysis · raw source retained</p></header>
    {'counts' in result ? <>
      <p className="decision-statement">{result.status === 'verified' ? 'Two documented 1980 placeholders are treated as unknown in derived analysis.' : 'Derived view needs review; its current counts are shown below.'}</p>
      <dl className="meta">
        <div><dt>Rows reviewed</dt><dd>{result.counts.total.toLocaleString('en-US')}</dd></div>
        <div><dt>Quarantined rows</dt><dd>{result.counts.quarantined}</dd></div>
        <div><dt>Quarantined dates now unknown</dt><dd>{result.counts.normalized_unknown}</dd></div>
        <div><dt>Original placeholders retained</dt><dd>{result.counts.original_placeholders_retained}</dd></div>
      </dl>
      <p className="section-note">Raw expiration values preserved: {result.counts.raw_values_preserved ? 'yes' : 'not verified'}. Full population preserved: {result.counts.population_preserved ? 'yes' : 'not verified'}. Reviewed mirror binding: {result.counts.reviewed_mirror ? 'matched' : 'not verified'}.</p>
    </> : <p className="not-yet">{result.status === 'not-installed' ? 'Derived review view is not installed.' : 'Derived review counts are unavailable; no correction is claimed.'}</p>}
    <p className="section-note">This does not change the raw source, erase the remaining 91/52 observations, or refresh stale DEV data. It is not a new Sodabase pass or an overall quality score. No member details are displayed.</p>
  </section>;
}
