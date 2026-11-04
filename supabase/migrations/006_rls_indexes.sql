-- Row-level security on every memory and coordination table, plus indexes for the queries the runner,
-- gate and dashboard actually make. Service roles keep exactly the access their grants already give;
-- anon and authenticated get nothing. The table owner and Sodabase's read-only role are unaffected.
do $$ declare t record; begin
  for t in select schemaname s, tablename n from pg_tables where schemaname = 'cm' loop
    execute format('alter table %I.%I enable row level security', t.s, t.n);
    execute format('create policy service_roles on %I.%I for all to agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader using (true) with check (true)', t.s, t.n);
  end loop;
  for t in select schemaname s, tablename n from pg_tables where schemaname = 'coord' loop
    execute format('alter table %I.%I enable row level security', t.s, t.n);
    execute format('create policy service_roles on %I.%I for all to coord_writer, dashboard_reader using (true) with check (true)', t.s, t.n);
  end loop;
end $$;

create index if not exists runs_status_created on cm.runs (status, created_at desc);
create index if not exists runs_parent on cm.runs (parent_run_id) where parent_run_id is not null;
create index if not exists run_decisions_decision on cm.run_decisions (decision_id);
create index if not exists decisions_source on cm.decisions (source_id);
create index if not exists decisions_supersedes on cm.decisions (supersedes_id) where supersedes_id is not null;
create index if not exists attempts_contract on cm.attempts (contract_id);
create index if not exists evidence_output on cm.evidence (output_id, created_at);
create index if not exists evaluations_current on cm.evaluations (run_id, attempt_id, output_id, check_id, created_at desc);
create index if not exists evaluations_evidence on cm.evaluations (evidence_id) where evidence_id is not null;
create index if not exists gate_decisions_run on cm.gate_decisions (run_id, created_at desc);
create index if not exists findings_target on cm.findings (target_output_id);
create index if not exists findings_decision on cm.findings (decision_id);
create index if not exists findings_open on cm.findings (status, created_at desc);
create index if not exists quality_findings_table on cm.quality_findings (table_name, observed_at desc);
