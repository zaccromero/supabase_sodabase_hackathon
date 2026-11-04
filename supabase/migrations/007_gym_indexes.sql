-- Migration request from lane 2. Governor applies.
-- Query shapes the demo runs that fall back to a sequential scan on hosted Supabase
-- (EXPLAIN ANALYZE, 2026-11-04, docs/receipts/gym-indexes-freshness-*.json).
-- All of them are fast at today's row counts. These stop the cost growing with each sync run,
-- mirror and check-in. Every foreign key in gym is already indexed.

-- The evaluators' and the canonical count's "latest run per location".
-- amsr_location_finished_idx cannot serve this because it orders by finished_at.
create index if not exists amsr_location_started_idx
  on gym.ezf_active_membership_sync_runs (location_id, started_at desc);

-- "Latest complete projection per location", the wording of gym.active_individual_definition.
create index if not exists amsr_complete_location_started_idx
  on gym.ezf_active_membership_sync_runs (location_id, started_at desc)
  where status = 'complete';

-- Newest check-in across all locations, for data age.
-- checkins_location_time_idx leads with location_id, so this scans the whole index today.
create index if not exists checkins_time_idx
  on gym.checkins (checked_in_at desc);

-- Latest snapshot per location. The primary key leads with snapshot_date, so it cannot serve this.
create index if not exists finance_location_date_idx
  on gym.finance_snapshots (location_id, snapshot_date desc);

-- The churned_at comparison the demo shows as not canonical, and recent-churn questions.
create index if not exists members_location_churned_idx
  on gym.members (location_id, churned_at);
