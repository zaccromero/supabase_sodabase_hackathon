-- Narrow read grants for the Sodabase role on the allowlisted, pseudonymized mirror and three memory tables.
-- No writes, no other schemas, no default grants on future tables, no BYPASSRLS or policy change.
grant usage on schema gym, cm to soda_readonly_c68226d2fe1d;
grant select on
  gym.locations, gym.members, gym.checkins,
  gym.ezf_active_memberships, gym.ezf_active_membership_sync_runs,
  gym.checkin_sync_runs, gym.finance_snapshots,
  cm.decisions, cm.evaluations, cm.runs
to soda_readonly_c68226d2fe1d;
