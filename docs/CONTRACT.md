# Shared contract (frozen 2026-11-04; changes go through the governor chat only)

Deadline: **work-ready 17:50 ET, submit 18:30 ET**. Source of truth for tables and rules: `supabase/migrations/001_core.sql`, proven by `tests/gate.test.ts`. Types: `src/contract/types.ts`. Hash: `src/contract/hash.ts`.

## One production board (owner, 2026-11-04)
- **The only evidence board is https://company-memory-zacc-r.vercel.app**, built from `app/` on `main`, reading hosted Supabase `dgqcanfiapxztmqqlqnh`. Port 4971 is a local view of the same app and the same data.
- No other evidence board, mock or deployment. Other packages feed this one; they do not run beside it.
- All runs write to hosted Supabase. PGlite and local Postgres are for tests only and never appear as results.
- Only the Dashboard lane deploys, only from a commit on `main`, after the governor merges it.
- "Prod" here means this hackathon project only. Gym NYC and Milo production stay off limits.

## Non-negotiables
- No fake data. Real sources only; historical items stay labeled `historical`; fault injection is labeled. Never fabricate an incident or a pass.
- No DEV scheduler restart, no PROD access, no change in any company repo, no external publication, no new lanes. Other repos are read-only.
- No member PII leaves Neon. The investor deck and memo are NOT_FOR_DISTRIBUTION: one slide's text only, no financial figures.
- Secrets only from Doppler `hackathon/dev` by name; never print them. Heavy commands: `/Users/zaccromero/bin/mac-workload run /absolute/executable args`.

## Bindings
`run` 1—1 `check_contract` (frozen, hash `contract_sha256`) 1—N `attempt` 1—1 `output` (`output_sha256`) 1—N `evidence`.
An `evaluation` names run, attempt, output, contract, check and both hashes. The database rejects any mismatch. The gate reads only the **latest attempt**, so a repair invalidates every earlier pass.

## How results enter the gate
1. Runner (`gate_service`) creates run, pins accepted decisions in `run_decisions`, inserts checks, sets `contract_sha256 = sha256(checks)` and `frozen_at`.
2. Runner creates attempt. Handler result is written as `agent_worker` to `outputs` and `evidence`.
3. Each evaluator result is inserted as `evaluator_service` into `evidence` then `evaluations`.
4. Runner calls `select cm.request_completion(run_id)` as `gate_service`. Result: `completed`, `blocked` or `awaiting_approval`. Every verdict lands in `gate_decisions`.
5. `uncertain` needs a `founder_approver` row in `approvals`. Then the runner calls the gate again.

`agent_worker` cannot write evaluations, change run state, call the gate, or accept decisions. Only `founder_approver` accepts a decision.

## Payload examples
Evaluation insert:
```json
{"run_id":"…","attempt_id":"…","output_id":"…","contract_id":"…","check_id":"gym.canonical_definition","output_sha256":"…","contract_sha256":"…","evaluator":"det.gym_definition","evaluator_version":"1","verdict":"fail","reason":"Counted churned_at IS NULL, not MATCHED_INDIVIDUAL","evidence_id":"…"}
```
Gate result:
```json
{"run_id":"…","verdict":"blocked","missing":[{"check_id":"gym.canonical_definition","reason":"FAILED","evaluation_id":"…"}]}
```
Missing reasons: `CONTRACT_NOT_FROZEN NO_ATTEMPT NO_OUTPUT NO_CURRENT_EVALUATION NO_CURRENT_EVIDENCE FAILED NEEDS_FOUNDER_APPROVAL`.
Finding (`cm.findings`, read through `cm.v_finding_chain`):
```json
{"target_output_id":"…","decision_id":"…","excerpt":"the founder's own gym","explanation":"Conflicts with accepted decision milo.gym_nyc_partner v1","proposed_repair":"Describe Gym NYC as a partner"}
```
Gym operator output body:
```json
{"answer":[{"location_id":"lex","active_individual_members":0}],"definition":"MATCHED_INDIVIDUAL, latest complete projection","data_as_of":"…","data_age_days":0,"sql":"…"}
```
Milo output body: `{"slide_id":"…","before":"…","after":"…","claims":[{"text":"…","source":"…"}]}`.

## Lanes and path ownership
Each lane works on its own branch in its own worktree and commits there. The governor chat merges to `main` and applies migrations. Touch nothing outside your paths. Need a schema change? Add a file to `docs/migration-requests/`.
| Lane | Paths |
|---|---|
| Governor | `supabase/migrations/`, `src/contract/`, `main` |
| 1 Runner + memory | `src/runner/`, `src/memory/`, `tests/runner*` |
| 2 Sources: data, decisions, reel | `tools/mirror.ts`, `export-manifest.json`, `src/data/`, `src/reel/`, `tests/data*`, `tests/reel*` |
| 3 Agents | `src/agents/`, `tests/agents*` |
| 4 Evaluators + Sodabase | `src/evaluators/`, `src/sodabase/`, `docs/receipts/`, `tests/evaluators*`, `tests/sodabase*` |
| 5 Dashboard + demo | `app/`, `docs/DEMO.md` |

Provider credentials (`SUPABASE_*`, `SODABASE_MCP_TOKEN`) may not exist yet. Build and test against PGlite (see `tests/gate.test.ts`); use the real service as soon as Doppler has it. A missing credential blocks only the live call.
