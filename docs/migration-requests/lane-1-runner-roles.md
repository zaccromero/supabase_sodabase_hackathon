# Migration request from lane 1 (runner)

## 1. REQUIRED for the live path: let the connecting user take the service roles

Without this, every runner call on a non-superuser connection fails with `permission denied to set role "agent_worker"`.

```sql
grant agent_worker, evaluator_service, gate_service, founder_approver, dashboard_reader to postgres;
```

**Evidence.** Local Postgres 16.15, `postgres` as a non-superuser with `CREATEROLE`, migration 001 applied as that user:
- Before the grant, `SET LOCAL ROLE agent_worker` was refused with the error above.
- After the grant, the repair path, budget path and fresh-run path all passed through the `pg` driver.

PGlite cannot show this failure, because its session user is a superuser. `tests/gate.test.ts` and `tests/runner.test.ts` both stay green either way.

**Not verified on Supabase.** `SUPABASE_*` is not in Doppler yet. The request assumes the Supabase connection user is the non-superuser `postgres`, and that the project runs Postgres 16 or later. The grant does no harm if either assumption is wrong. Any role the dashboard connects as needs the same membership.

## 2. OPTIONAL hardening: rules the runner enforces today but the database does not

None of this blocks the demo. Each rule moves from application code to the database, which matches the pitch. The SQL below is a sketch and has not been run.

**A finding can be marked `verified` without a completed run.** `evaluator_service` and `founder_approver` can both write `status = 'verified'` directly. `settleVerification` applies the condition, but only for callers that use it.

```sql
create function cm.guard_finding() returns trigger language plpgsql as $$
begin
  if new.status = 'verified' and old.status is distinct from 'verified' and not exists (
    select 1 from cm.runs r join cm.run_decisions rd on rd.run_id = r.id
    where r.id = new.verifying_run_id and r.status = 'completed' and rd.decision_id = new.correction_decision_id
  ) then raise exception 'FINDING_NOT_VERIFIED_BY_RUN'; end if;
  return new;
end $$;
create trigger t_guard before update on cm.findings for each row execute function cm.guard_finding();
```

**A contract with no required check completes vacuously.** `cm.gate_missing` returns `[]`, so the gate says `completed`. The runner refuses to freeze such a contract (`NO_REQUIRED_CHECKS`). The database should also refuse it, in `cm.guard_contract`, when `frozen_at` is being set.

**`failed` is not terminal.** `cm.request_completion` on a failed run overwrites the status. The runner never makes that call, but `cm.guard_run` could reject any status change out of `failed`.
