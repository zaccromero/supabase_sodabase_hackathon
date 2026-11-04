-- Applied to dgqcanfiapxztmqqlqnh at 2026-11-04 23:24 UTC through the Codex Supabase connector. Recorded here for history; do not reapply.
-- CANDIDATE ONLY: existing integrator owns naming, review and application.
-- Target: event Supabase dgqcanfiapxztmqqlqnh. Never apply to the Gym source DB.
-- Source evidence: gym-nyc/docs/audits/db-accuracy-2026-07-29.md:174-178,301-302.
-- No UPDATE/DELETE; preserves raw IDs/timestamps. NULL below means unknown, not a guessed date.
-- Apply atomically via the project's migration mechanism.
BEGIN;
DO $$
BEGIN
  IF to_regclass('gym.v_member_expiration_review') IS NOT NULL
     OR to_regclass('gym.v_member_expiration_quarantine') IS NOT NULL THEN
    RAISE EXCEPTION 'STOP: candidate view already exists; reconcile rather than overwrite';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM gym.mirror_runs
    WHERE id = 'c08024fa-3825-4c69-96b9-d9a83e08703b'
      AND manifest_sha256 = '36f6bc988f1ad164a17a9dcb95ecedbaabafed37766b6bc56a8fe5b37841c638'
      AND source_label = 'gym-nyc/dev'
  ) THEN RAISE EXCEPTION 'STOP: expected reviewed DEV mirror absent'; END IF;
  IF (SELECT count(*) FROM gym.members WHERE expiration_date < '1990-01-01') <> 2
     OR (SELECT count(*) FROM gym.members
         WHERE location_id='mul' AND ezf_contract_status='Expired'
           AND (joined_at AT TIME ZONE 'America/New_York')::date = DATE '2024-09-25'
           AND (expiration_date AT TIME ZONE 'America/New_York')::date
               IN (DATE '1980-06-30', DATE '1980-12-31')) <> 2
     OR (SELECT count(DISTINCT (expiration_date AT TIME ZONE 'America/New_York')::date)
         FROM gym.members WHERE expiration_date < '1990-01-01') <> 2 THEN
    RAISE EXCEPTION 'STOP: sentinel population differs from independently verified two records';
  END IF;
END $$;

CREATE VIEW gym.v_member_expiration_review
WITH (security_invoker=true, security_barrier=true) AS
WITH latest_mirror AS (
  SELECT id FROM gym.mirror_runs ORDER BY started_at DESC, id DESC LIMIT 1
), marked AS (
  SELECT m.id, m.location_id, m.ezf_contract_status,
    m.joined_at AS source_client_created_at,
    m.expiration_date AS source_expiration_date,
    m.last_synced_at AS source_last_synced_at,
    (m.location_id='mul' AND m.ezf_contract_status='Expired'
     AND (m.joined_at AT TIME ZONE 'America/New_York')::date = DATE '2024-09-25'
     AND (m.expiration_date AT TIME ZONE 'America/New_York')::date
         IN (DATE '1980-06-30', DATE '1980-12-31')) IS TRUE AS matches_known_placeholder
  FROM gym.members m
), scope AS (
  SELECT (SELECT id FROM latest_mirror) AS mirror_run_id,
    count(*) FILTER (WHERE matches_known_placeholder)=2 AS population_matches
  FROM marked
)
SELECT m.id AS source_member_id, m.location_id, m.ezf_contract_status,
  m.source_client_created_at, m.source_expiration_date, m.source_last_synced_at,
  s.mirror_run_id,
  (m.matches_known_placeholder AND s.population_matches
   AND s.mirror_run_id='c08024fa-3825-4c69-96b9-d9a83e08703b') AS quarantined,
  CASE WHEN m.matches_known_placeholder AND s.population_matches
             AND s.mirror_run_id='c08024fa-3825-4c69-96b9-d9a83e08703b'
       THEN NULL::timestamptz ELSE m.source_expiration_date END AS normalized_expiration_date,
  CASE WHEN m.matches_known_placeholder THEN
    'Known 1980 EZF placeholder; raw retained. Derived unknown only on the reviewed mirror/population.'
    ELSE 'Raw source value retained; no correction inferred.' END AS normalization_reason,
  'gym-nyc/docs/audits/db-accuracy-2026-07-29.md:174-178,301-302'::text AS source_audit
FROM marked m CROSS JOIN scope s;

CREATE VIEW gym.v_member_expiration_quarantine
WITH (security_invoker=true, security_barrier=true) AS
SELECT * FROM gym.v_member_expiration_review WHERE quarantined;
REVOKE ALL ON gym.v_member_expiration_review, gym.v_member_expiration_quarantine
FROM PUBLIC, anon, authenticated;
GRANT SELECT ON gym.v_member_expiration_review, gym.v_member_expiration_quarantine
TO dashboard_reader, evaluator_service;
COMMIT;

-- Acceptance after application (NOT RUN by this candidate):
-- 1. review row count equals raw gym.members row count; quarantined count exactly2.
-- 2. The two raw expiry timestamps/IDs remain present and unchanged; normalized values NULL.
-- 3. Every nonquarantined normalized value IS NOT DISTINCT FROM its raw value.
-- 4. Verify dashboard_reader/evaluator_service base-table privileges + RLS before wiring consumers.
-- 5. No new provider grants/monitors/scan or global score claim. Existing raw warnings remain truthful.
-- Recovery: remove consumers, then drop only these two new views through the migration owner.
