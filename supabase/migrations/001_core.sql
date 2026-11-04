-- Company memory core. Schema cm is NOT exposed through PostgREST.
create schema if not exists cm;

do $$ declare r text; begin
  foreach r in array array['agent_worker','evaluator_service','gate_service','founder_approver','dashboard_reader'] loop
    if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if;
  end loop;
end $$;

create table cm.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('repo_file','owner_note','reel','branch','historical_artifact')),
  uri text not null,
  title text not null,
  content_sha256 text,
  historical boolean not null default false,
  captured_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table cm.decisions (
  id uuid primary key default gen_random_uuid(),
  decision_key text not null,
  version int not null default 1,
  statement text not null,
  scope text[] not null,
  status text not null default 'proposed' check (status in ('proposed','accepted','superseded','rejected')),
  source_id uuid not null references cm.sources(id),
  supersedes_id uuid references cm.decisions(id),
  proposed_by text not null,
  accepted_by text,
  accepted_at timestamptz,
  implementation_state text not null default 'unknown' check (implementation_state in ('unknown','not_started','on_branch','on_main','deployed')),
  created_at timestamptz not null default now(),
  unique (decision_key, version),
  check (status <> 'accepted' or (accepted_by is not null and accepted_at is not null))
);
create unique index decisions_one_accepted on cm.decisions (decision_key) where status = 'accepted';

create table cm.techniques (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references cm.sources(id),
  media_sha256 text not null,
  model text not null,
  prompt_sha256 text not null,
  extraction jsonb not null,
  status text not null default 'proposed' check (status in ('proposed','applied','rejected')),
  created_at timestamptz not null default now(),
  unique (media_sha256, model, prompt_sha256)
);

create table cm.runs (
  id uuid primary key default gen_random_uuid(),
  profile text not null check (profile in ('gym_operator','milo_pitch','drift_reviewer')),
  task text not null,
  status text not null default 'pending' check (status in ('pending','running','blocked','awaiting_approval','completed','failed')),
  memory_mode text not null default 'on' check (memory_mode in ('on','baseline')),
  parent_run_id uuid references cm.runs(id),
  technique_id uuid references cm.techniques(id),
  repair_budget int not null default 2,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table cm.run_decisions (
  run_id uuid not null references cm.runs(id),
  decision_id uuid not null references cm.decisions(id),
  pinned_at timestamptz not null default now(),
  primary key (run_id, decision_id)
);

create table cm.check_contracts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references cm.runs(id),
  contract_sha256 text,
  frozen_at timestamptz,
  created_at timestamptz not null default now()
);

create table cm.contract_checks (
  contract_id uuid not null references cm.check_contracts(id),
  check_id text not null,
  kind text not null check (kind in ('deterministic','critic')),
  required boolean not null default true,
  requires_evidence boolean not null default true,
  decision_id uuid references cm.decisions(id),
  spec jsonb not null default '{}',
  primary key (contract_id, check_id)
);

create table cm.attempts (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references cm.runs(id),
  contract_id uuid not null references cm.check_contracts(id),
  attempt_no int not null,
  kind text not null check (kind in ('initial','repair')),
  created_at timestamptz not null default now(),
  unique (run_id, attempt_no)
);

create table cm.outputs (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references cm.attempts(id),
  body jsonb not null,
  output_sha256 text not null,
  created_at timestamptz not null default now()
);

create table cm.evidence (
  id uuid primary key default gen_random_uuid(),
  output_id uuid not null references cm.outputs(id),
  kind text not null,
  uri text,
  sha256 text,
  payload jsonb not null default '{}',
  created_by text not null,
  created_at timestamptz not null default now()
);

create table cm.evaluations (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references cm.runs(id),
  attempt_id uuid not null references cm.attempts(id),
  output_id uuid not null references cm.outputs(id),
  contract_id uuid not null references cm.check_contracts(id),
  check_id text not null,
  output_sha256 text not null,
  contract_sha256 text not null,
  evaluator text not null,
  evaluator_version text not null,
  verdict text not null check (verdict in ('pass','fail','uncertain')),
  reason text not null,
  evidence_id uuid references cm.evidence(id),
  created_at timestamptz not null default now()
);

create table cm.approvals (
  id uuid primary key default gen_random_uuid(),
  evaluation_id uuid not null unique references cm.evaluations(id),
  decision text not null check (decision in ('approved','rejected')),
  approver text not null,
  note text,
  created_at timestamptz not null default now()
);

create table cm.gate_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references cm.runs(id),
  attempt_id uuid references cm.attempts(id),
  verdict text not null check (verdict in ('completed','blocked','awaiting_approval')),
  missing jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table cm.findings (
  id uuid primary key default gen_random_uuid(),
  reviewer_run_id uuid references cm.runs(id),
  target_output_id uuid not null references cm.outputs(id),
  decision_id uuid not null references cm.decisions(id),
  excerpt text not null,
  explanation text not null,
  proposed_repair text not null,
  status text not null default 'open' check (status in ('open','corrected','verified','dismissed')),
  correction_decision_id uuid references cm.decisions(id),
  verifying_run_id uuid references cm.runs(id),
  created_at timestamptz not null default now()
);

create table cm.quality_findings (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_finding_id text,
  table_name text not null,
  verdict text not null,
  problem text,
  finding_count int,
  severity text,
  observed_at timestamptz not null default now(),
  raw jsonb not null default '{}'
);

-- Append-only records
create function cm.reject_mutation() returns trigger language plpgsql as $$
begin raise exception 'APPEND_ONLY: % is immutable', tg_table_name; end $$;
create trigger t_ro before update or delete on cm.evaluations for each row execute function cm.reject_mutation();
create trigger t_ro before update or delete on cm.evidence for each row execute function cm.reject_mutation();
create trigger t_ro before update or delete on cm.outputs for each row execute function cm.reject_mutation();
create trigger t_ro before update or delete on cm.approvals for each row execute function cm.reject_mutation();
create trigger t_ro before update or delete on cm.gate_decisions for each row execute function cm.reject_mutation();
create trigger t_ro before update or delete on cm.quality_findings for each row execute function cm.reject_mutation();

-- Frozen contract cannot change
create function cm.guard_contract() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.frozen_at is not null then raise exception 'CONTRACT_FROZEN'; end if;
    return old;
  end if;
  if old.frozen_at is not null then raise exception 'CONTRACT_FROZEN'; end if;
  return new;
end $$;
create trigger t_guard before update or delete on cm.check_contracts for each row execute function cm.guard_contract();

create function cm.guard_contract_checks() returns trigger language plpgsql as $$
declare cid uuid := coalesce(new.contract_id, old.contract_id); f timestamptz;
begin
  select frozen_at into f from cm.check_contracts where id = cid;
  if f is not null then raise exception 'CONTRACT_FROZEN'; end if;
  return coalesce(new, old);
end $$;
create trigger t_guard before insert or update or delete on cm.contract_checks for each row execute function cm.guard_contract_checks();

-- Attempts need a frozen contract and respect the repair budget
create function cm.guard_attempt() returns trigger language plpgsql as $$
declare f timestamptz; budget int; used int;
begin
  select frozen_at into f from cm.check_contracts where id = new.contract_id and run_id = new.run_id;
  if f is null then raise exception 'CONTRACT_NOT_FROZEN'; end if;
  if new.kind = 'repair' then
    select repair_budget into budget from cm.runs where id = new.run_id;
    select count(*) into used from cm.attempts where run_id = new.run_id and kind = 'repair';
    if used >= budget then raise exception 'REPAIR_BUDGET_EXHAUSTED'; end if;
  end if;
  return new;
end $$;
create trigger t_guard before insert on cm.attempts for each row execute function cm.guard_attempt();

-- An evaluation must bind to the exact attempt, output and frozen contract
create function cm.guard_evaluation() returns trigger language plpgsql as $$
declare a record; o record; c record;
begin
  select * into a from cm.attempts where id = new.attempt_id;
  select * into o from cm.outputs where id = new.output_id;
  select * into c from cm.check_contracts where id = new.contract_id;
  if a.run_id <> new.run_id or a.contract_id <> new.contract_id then raise exception 'BINDING_ATTEMPT_MISMATCH'; end if;
  if o.attempt_id <> new.attempt_id then raise exception 'BINDING_OUTPUT_MISMATCH'; end if;
  if o.output_sha256 <> new.output_sha256 then raise exception 'BINDING_OUTPUT_HASH_MISMATCH'; end if;
  if c.contract_sha256 is distinct from new.contract_sha256 then raise exception 'BINDING_CONTRACT_HASH_MISMATCH'; end if;
  if not exists (select 1 from cm.contract_checks where contract_id = new.contract_id and check_id = new.check_id) then
    raise exception 'BINDING_UNKNOWN_CHECK'; end if;
  if new.evidence_id is not null and not exists (select 1 from cm.evidence where id = new.evidence_id and output_id = new.output_id) then
    raise exception 'BINDING_EVIDENCE_MISMATCH'; end if;
  return new;
end $$;
create trigger t_guard before insert on cm.evaluations for each row execute function cm.guard_evaluation();

-- What is still missing for the current attempt. Empty array means completable.
create function cm.gate_missing(p_run uuid) returns jsonb language plpgsql stable as $$
declare a record; o record; c record; ch record; e record; missing jsonb := '[]';
begin
  select * into c from cm.check_contracts where run_id = p_run;
  if c.id is null or c.frozen_at is null then return '[{"reason":"CONTRACT_NOT_FROZEN"}]'; end if;
  select * into a from cm.attempts where run_id = p_run order by attempt_no desc limit 1;
  if a.id is null then return '[{"reason":"NO_ATTEMPT"}]'; end if;
  select * into o from cm.outputs where attempt_id = a.id;
  if o.id is null then return '[{"reason":"NO_OUTPUT"}]'; end if;
  for ch in select * from cm.contract_checks where contract_id = c.id and required loop
    select * into e from cm.evaluations
      where run_id = p_run and attempt_id = a.id and output_id = o.id and contract_id = c.id
        and check_id = ch.check_id and output_sha256 = o.output_sha256 and contract_sha256 = c.contract_sha256
      order by created_at desc, id desc limit 1;
    if e.id is null then
      missing := missing || jsonb_build_object('check_id', ch.check_id, 'reason', 'NO_CURRENT_EVALUATION');
    elsif ch.requires_evidence and e.evidence_id is null then
      missing := missing || jsonb_build_object('check_id', ch.check_id, 'reason', 'NO_CURRENT_EVIDENCE');
    elsif e.verdict = 'fail' then
      missing := missing || jsonb_build_object('check_id', ch.check_id, 'reason', 'FAILED', 'evaluation_id', e.id);
    elsif e.verdict = 'uncertain' and not exists (select 1 from cm.approvals where evaluation_id = e.id and decision = 'approved') then
      missing := missing || jsonb_build_object('check_id', ch.check_id, 'reason', 'NEEDS_FOUNDER_APPROVAL', 'evaluation_id', e.id);
    end if;
  end loop;
  return missing;
end $$;

-- Completed can only be reached through a passing gate, for any caller
create function cm.guard_run() returns trigger language plpgsql as $$
declare m jsonb;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    m := cm.gate_missing(new.id);
    if jsonb_array_length(m) > 0 then raise exception 'GATE_REJECTED: %', m; end if;
    new.completed_at := now();
  end if;
  if old.status = 'completed' then raise exception 'RUN_ALREADY_COMPLETED'; end if;
  return new;
end $$;
create trigger t_guard before update on cm.runs for each row execute function cm.guard_run();

-- Only entry point the runner uses to finish a run. Records every verdict.
create function cm.request_completion(p_run uuid) returns jsonb language plpgsql security definer set search_path = cm, pg_temp as $$
declare m jsonb; v text; a uuid;
begin
  m := cm.gate_missing(p_run);
  select id into a from cm.attempts where run_id = p_run order by attempt_no desc limit 1;
  if jsonb_array_length(m) = 0 then v := 'completed';
  elsif not exists (select 1 from jsonb_array_elements(m) x where x->>'reason' <> 'NEEDS_FOUNDER_APPROVAL') then v := 'awaiting_approval';
  else v := 'blocked'; end if;
  update cm.runs set status = v where id = p_run;
  insert into cm.gate_decisions (run_id, attempt_id, verdict, missing) values (p_run, a, v, m);
  return jsonb_build_object('run_id', p_run, 'verdict', v, 'missing', m);
end $$;

-- Grants: the editing worker writes only outputs and evidence.
grant usage on schema cm to agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader;
revoke all on all tables in schema cm from public;
revoke execute on function cm.request_completion(uuid) from public;
grant select on cm.runs, cm.run_decisions, cm.check_contracts, cm.contract_checks, cm.attempts, cm.outputs, cm.evidence, cm.sources, cm.decisions, cm.techniques to agent_worker;
grant insert on cm.outputs, cm.evidence to agent_worker;
grant select on all tables in schema cm to evaluator_service, gate_service, founder_approver, dashboard_reader;
grant insert on cm.evaluations, cm.evidence, cm.quality_findings to evaluator_service;
grant insert, update on cm.findings to evaluator_service;
grant insert, update on cm.runs, cm.run_decisions, cm.check_contracts, cm.contract_checks, cm.attempts, cm.sources, cm.techniques to gate_service;
grant insert on cm.decisions to gate_service;
grant execute on function cm.request_completion(uuid) to gate_service;
grant execute on function cm.gate_missing(uuid) to agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader;
grant insert on cm.approvals to founder_approver;
grant update (status, accepted_by, accepted_at, implementation_state) on cm.decisions to founder_approver;
grant update (status, correction_decision_id, verifying_run_id) on cm.findings to founder_approver;

-- Agents and services can only propose. Acceptance is the founder's.
create function cm.guard_decision() returns trigger language plpgsql as $$
begin
  if new.status = 'accepted' and current_user in ('agent_worker','evaluator_service','gate_service') then
    raise exception 'ONLY_FOUNDER_ACCEPTS';
  end if;
  return new;
end $$;
create trigger t_guard before insert or update on cm.decisions for each row execute function cm.guard_decision();

-- Dashboard read models
create view cm.v_run_status as
select r.id run_id, r.profile, r.task, r.status, r.memory_mode, r.parent_run_id, r.created_at, r.completed_at,
  a.id attempt_id, a.attempt_no, o.id output_id, o.output_sha256, c.id contract_id, c.contract_sha256,
  cm.gate_missing(r.id) missing
from cm.runs r
left join cm.check_contracts c on c.run_id = r.id
left join lateral (select * from cm.attempts x where x.run_id = r.id order by attempt_no desc limit 1) a on true
left join cm.outputs o on o.attempt_id = a.id;

create view cm.v_finding_chain as
select f.id finding_id, f.status, d.decision_key, d.version decision_version, d.statement decision_statement,
  s.uri decision_source, s.historical source_historical, f.excerpt, f.explanation, f.proposed_repair,
  f.target_output_id, f.correction_decision_id, f.verifying_run_id, vr.status verifying_run_status, f.created_at
from cm.findings f
join cm.decisions d on d.id = f.decision_id
join cm.sources s on s.id = d.source_id
left join cm.runs vr on vr.id = f.verifying_run_id;

grant select on cm.v_run_status, cm.v_finding_chain to evaluator_service, gate_service, founder_approver, dashboard_reader;
