-- Migration request from lane 4 (data quality). For the governor to apply. Sodabase finding: cm.decisions
-- "created_at must be on or before accepted_at", 6 rows.
--
-- Root cause: tools/import-approved.ts inserts each row at import (created_at 22:14:44Z) and then writes the owner's
-- earlier approval time (21:39:16Z) into accepted_at. One column was holding two different events.
--
-- Fix: record both events, each with its true time. Nothing is backdated and no time is invented:
--   owner_approved_at = when the owner approved, from docs/sources/owner-approval.json
--   accepted_at       = when the decision became accepted in this database. The import did that in the same
--                       transaction as the insert, so it equals created_at for these rows.
-- Provenance moves, it is not lost: the approver stays in accepted_by and the approval time in owner_approved_at.
alter table cm.decisions add column owner_approved_at timestamptz;
comment on column cm.decisions.owner_approved_at is 'When the owner approved, where that happened before this row existed. accepted_at is when it became accepted in this database.';
grant update (owner_approved_at) on cm.decisions to founder_approver;

update cm.decisions
   set owner_approved_at = accepted_at, accepted_at = created_at
 where status = 'accepted' and accepted_at < created_at;

-- Companion change in tools/import-approved.ts, so the next import does not recreate this:
--   update cm.decisions set status = 'accepted', accepted_by = $2, accepted_at = now(), owner_approved_at = $3
--    where id = $1 and status = 'proposed'
