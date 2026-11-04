-- Migration request from lane 2 (Sources). Governor applies.
-- Mirror of DEV Gym NYC data (Neon schema public -> Supabase schema gym).
-- Pseudonymised by tools/mirror.ts under the allowlist in export-manifest.json:
-- names, emails, phones, raw JSON, free text and source_row_sha256 are never selected.
-- Every hmac_* check rejects a raw source identifier that slips past the mirror.
-- Schema gym must NOT be added to the PostgREST exposed schemas.
create schema if not exists gym;

create table gym.locations (
  id text primary key,
  lat double precision,
  lng double precision,
  created_at timestamptz
);

create table gym.members (
  id uuid primary key,
  ezf_client_id text unique constraint hmac_ezf_client_id check (ezf_client_id ~ '^[0-9a-f]{64}$'),
  ezf_membership_number text constraint hmac_ezf_membership_number check (ezf_membership_number ~ '^[0-9a-f]{64}$'),
  location_id text references gym.locations(id),
  membership_type text,
  membership_tier text,
  expiration_date timestamptz,
  term_months integer,
  joined_at timestamptz not null,
  churned_at timestamptz,
  ezf_contract_status text,
  last_check_in timestamptz,
  is_modification_cancel boolean,
  last_synced_at timestamptz
);
create index members_location_idx on gym.members (location_id);

create table gym.checkins (
  id uuid primary key,
  member_id uuid not null references gym.members(id),
  location_id text not null references gym.locations(id),
  checked_in_at timestamptz not null,
  ezf_checkin_id text unique constraint hmac_ezf_checkin_id check (ezf_checkin_id ~ '^[0-9a-f]{64}$'),
  source text,
  ingested_at timestamptz
);
create index checkins_location_time_idx on gym.checkins (location_id, checked_in_at);
create index checkins_member_idx on gym.checkins (member_id);

-- Full-replace on every mirror run, inside one transaction.
create table gym.ezf_active_memberships (
  id uuid primary key,
  location_id text not null references gym.locations(id),
  source_membership_key text not null constraint hmac_source_membership_key check (source_membership_key ~ '^[0-9a-f]{64}$'),
  ezf_membership_number text not null constraint hmac_am_membership_number check (ezf_membership_number ~ '^[0-9a-f]{64}$'),
  member_id uuid references gym.members(id),
  membership_mode text not null,
  membership_start date not null,
  membership_end date not null,
  bridge_class text not null constraint am_bridge_class check (bridge_class in (
    'MATCHED_INDIVIDUAL',
    'EXCLUDED_INDEPENDENT_TRAINING_MEMBER',
    'EXCLUDED_INDEPENDENT_TRAINER',
    'EXCLUDED_CORPORATE',
    'EXCLUDED_EMPLOYEE',
    'EXCLUDED_NON_MEMBER',
    'EXCLUDED_HOTEL',
    'MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT'
  )),
  report_as_of date not null,
  source_csv_sha256 text not null,
  source_last_seen_at timestamptz not null,
  ingested_at timestamptz not null,
  updated_at timestamptz not null,
  unique (location_id, source_membership_key)
);
create index am_location_class_idx on gym.ezf_active_memberships (location_id, bridge_class);
create index am_member_idx on gym.ezf_active_memberships (member_id);

create table gym.ezf_active_membership_sync_runs (
  id uuid primary key,
  location_id text not null references gym.locations(id),
  report_as_of date,
  report_filter_version text not null,
  started_at timestamptz not null,
  finished_at timestamptz,
  source_csv_sha256 text,
  source_rows_total integer not null,
  unique_membership_keys integer not null,
  active_individual_members integer not null,
  explained_exclusions integer not null,
  structural_differences integer not null,
  unmapped_members integer not null,
  unexplained_records integer not null,
  status text not null constraint amsr_status check (status in ('running','complete','failed')),
  had_errors boolean not null,
  parse_drift boolean not null,
  error_code text,
  constraint amsr_zero_unexplained_complete check (status <> 'complete' or (unmapped_members = 0 and unexplained_records = 0)),
  constraint amsr_bridge_balance check (status <> 'complete' or source_rows_total = active_individual_members + explained_exclusions + structural_differences)
);
create index amsr_location_finished_idx on gym.ezf_active_membership_sync_runs (location_id, finished_at);

create table gym.checkin_sync_runs (
  id uuid primary key,
  location_id text not null references gym.locations(id),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  source_events_fetched integer not null,
  matched_events integer not null,
  inserted_events integer not null,
  duplicate_events integer not null,
  unmatched_events integer not null,
  parse_error_count integer not null,
  source_retry_count integer not null,
  latest_source_event_at timestamptz,
  had_error boolean not null,
  error_code text,
  duration_seconds double precision not null
);
create index checkin_runs_location_finished_idx on gym.checkin_sync_runs (location_id, finished_at);

-- location_id has no FK: the source also stores the rollup value 'all'.
create table gym.finance_snapshots (
  snapshot_date date not null,
  location_id text not null,
  recurring_mrr_cents integer not null,
  committed_mrr_cents integer not null,
  fee_unknown_count integer not null,
  active_members integer not null,
  churned_members_total integer not null,
  ar_total_cents integer not null,
  ar_source text not null,
  flagged text,
  computed_at timestamptz not null,
  primary key (snapshot_date, location_id)
);

-- One row per successful mirror. Counts only.
create table gym.mirror_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  manifest_sha256 text not null,
  source_label text not null,
  table_counts jsonb not null
);

-- Readers only. The mirror writes as the migration owner through SUPABASE_DB_URL.
-- Row level security stays on so anon and authenticated see nothing if gym is ever exposed.
do $$
declare t text; r text;
begin
  foreach t in array array['locations','members','checkins','ezf_active_memberships','ezf_active_membership_sync_runs','checkin_sync_runs','finance_snapshots','mirror_runs'] loop
    execute format('revoke all on gym.%I from public', t);
    execute format('alter table gym.%I enable row level security', t);
    foreach r in array array['agent_worker','evaluator_service','gate_service','founder_approver','dashboard_reader'] loop
      execute format('grant select on gym.%I to %I', t, r);
      execute format('create policy %I on gym.%I for select to %I using (true)', 'read_' || r, t, r);
    end loop;
  end loop;
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema gym from %I', r);
      execute format('revoke usage on schema gym from %I', r);
    end if;
  end loop;
end $$;
grant usage on schema gym to agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader;
