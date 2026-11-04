-- From lane 1. The connecting user must be able to take the service roles.
grant agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader to postgres;

-- A finding is verified only by a completed run that pinned the correction.
create function cm.guard_finding() returns trigger language plpgsql as $$
begin
  if new.status = 'verified' and old.status is distinct from 'verified' and not exists (
    select 1 from cm.runs r join cm.run_decisions rd on rd.run_id = r.id
    where r.id = new.verifying_run_id and r.status = 'completed' and rd.decision_id = new.correction_decision_id
  ) then raise exception 'FINDING_NOT_VERIFIED_BY_RUN'; end if;
  return new;
end $$;
create trigger t_guard before update on cm.findings for each row execute function cm.guard_finding();
