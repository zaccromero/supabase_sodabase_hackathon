import { dbMode, withRole } from '@/lib/db';

export const ISSUE_REVIEW_SQL = `select
 (select count(*) from cm.decisions where accepted_at < created_at)::text as invalid_decision_dates,
 (select count(*) from cm.decisions where owner_approved_at is not null)::text as retained_approval_times,
 (select count(*) from gym.members where ezf_membership_number is null)::text as missing_numbers,
 (select count(*) from gym.members where ezf_membership_number is null and ezf_contract_status is null and membership_type='other')::text as no_status_numbers,
 (select count(*) from gym.members where ezf_membership_number is null and ezf_contract_status='Expired' and membership_type='pif_12')::text as expired_annual_numbers,
 (select count(*) from gym.ezf_active_memberships where member_id is null)::text as missing_member_links,
 (select count(*) from gym.ezf_active_memberships where member_id is null and bridge_class in ('EXCLUDED_INDEPENDENT_TRAINING_MEMBER','EXCLUDED_NON_MEMBER'))::text as explained_member_links,
 (select count(*) from gym.ezf_active_memberships where member_id is null and bridge_class='MATCHED_INDIVIDUAL')::text as missing_individual_links,
 (select count(*) from gym.finance_snapshots f left join gym.locations l on l.id=f.location_id where l.id is null and f.location_id='all')::text as expected_rollups,
 (select count(*) from gym.finance_snapshots f left join gym.locations l on l.id=f.location_id where l.id is null and f.location_id<>'all')::text as unexplained_locations`;

export async function SodabaseIssueReview() {
  if (dbMode() !== 'live') return null;
  let counts: Record<string, number> | null = null;
  try {
    const rows = await withRole('dashboard_reader', tx => tx.query<Record<string, unknown>>(ISSUE_REVIEW_SQL));
    const row = rows[0];
    if (row && Object.values(row).every(value => typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)))) {
      counts = Object.fromEntries(Object.entries(row).map(([key,value]) => [key, Number(value)]));
    }
  } catch { /* A missing permission/column is unavailable evidence, never a zero. */ }
  return <section aria-labelledby="q-issue-review">
    <header className="section-head"><h2 className="question" id="q-issue-review">What did the issue investigation establish?</h2><p className="age">Current read-only database checks</p></header>
    {!counts ? <p className="not-yet">Current checks are unavailable. No resolution is claimed.</p> : <>
      <dl className="meta">
        <div><dt>Decision date-order violations now</dt><dd>{counts.invalid_decision_dates}</dd></div>
        <div><dt>Original owner approval times retained</dt><dd>{counts.retained_approval_times}</dd></div>
        <div><dt>Missing membership numbers · review</dt><dd>{counts.missing_numbers}</dd></div>
        <div><dt>Missing member links in expected exclusion classes</dt><dd>{counts.explained_member_links} of {counts.missing_member_links}</dd></div>
        <div><dt>Missing links on matched individuals · review</dt><dd>{counts.missing_individual_links}</dd></div>
        <div><dt>Expected all-location rollups</dt><dd>{counts.expected_rollups}</dd></div>
        <div><dt>Unexplained location references · review</dt><dd>{counts.unexplained_locations}</dd></div>
      </dl>
      <p className="section-note">Membership-number coverage needs source reconciliation: {counts.no_status_numbers} records have no contract status and type other; {counts.expired_annual_numbers} are expired annual memberships. Missing status does not prove a record is an expected non-member. No replacement numbers are invented.</p>
      <p className="section-note">The decision-date repair separates database acceptance from the earlier owner approval. These current SQL checks are separate from historical Sodabase warnings. The Sodabase decision-date rule recheck at Nov 4, 19:07 ET was unavailable; no new provider pass or cleared-issue count is claimed.</p>
    </>}
    <p className="section-note">Source freshness, the 91/52 date comparisons and the two preserved expiry placeholders remain labeled separately. An empty optional field alone is not proof of corruption. Overall Sodabase judging score: unknown.</p>
  </section>;
}
