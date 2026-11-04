// One real model call per profile. Runs only with AGENTS_LIVE=1, so `vitest run` stays offline.
// Writes what happened to AGENTS_LIVE_RECORD. Gym uses the real mirror through GYM_DATABASE_URL.
// Without it, gym runs against an empty copy of the real table shapes: this proves the model and
// tool loop only, returns no member numbers, and is recorded as schema_only_no_data.
import { readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { HandlerResult, PinnedDecision } from '../src/contract/types.js';
import { createHandlers, driftReviewTask } from '../src/agents/index.js';
import { gymReaderFromEnv, readerFromExecutor } from '../src/agents/gymReader.js';

const live = process.env.AGENTS_LIVE === '1' && (process.env.MODEL_TRANSPORT === 'cli' || !!process.env.ANTHROPIC_API_KEY);
const record: Record<string, unknown> = {};
const save = () => { if (process.env.AGENTS_LIVE_RECORD) writeFileSync(process.env.AGENTS_LIVE_RECORD, JSON.stringify(record, null, 2)); };
const base = { runId: 'live-check', attemptNo: 1 };

// Real statement from the source packet. Its status there is `proposed`: this exercises the
// reviewer, and is not a founder acceptance. Only the runner pins accepted decisions.
const PACKET_DECISIONS = '/Users/zaccromero/Documents/Codex/2026-11-04/hackathon-sources/outputs/source-packet/data/curated/decisions.proposed.json';
function proposedMiloPartner(): PinnedDecision {
  const all = JSON.parse(readFileSync(PACKET_DECISIONS, 'utf8')) as Array<{ id: string; version: number; statement: string; status: string; source_id: string }>;
  const found = all.find((d) => d.id === 'milo-partner')!;
  return { id: found.id, decision_key: found.id, version: found.version, statement: found.statement, source_uri: found.source_id, source_historical: false };
}

async function emptyGymShapes() {
  const db = new PGlite();
  await db.exec(`
    create schema gym;
    create table gym.locations (id text primary key, created_at timestamptz);
    create table gym.members (id uuid primary key, location_id text, membership_type text, membership_tier text, expiration_date timestamptz, joined_at timestamptz, churned_at timestamptz, ezf_contract_status text, last_synced_at timestamptz);
    create table gym.ezf_active_memberships (id uuid primary key, location_id text, source_membership_key text, member_id uuid, membership_mode text, membership_start date, membership_end date, bridge_class text, report_as_of date, source_last_seen_at timestamptz);
    create table gym.ezf_active_membership_sync_runs (id uuid primary key, location_id text, report_as_of date, finished_at timestamptz, status text, active_individual_members int);
  `);
  return readerFromExecutor((text) => db.query(text) as never);
}

describe.runIf(live)('live model calls', () => {
  let miloResult: HandlerResult | undefined;
  it('milo_pitch', async () => {
    miloResult = await createHandlers().milo_pitch({ ...base, task: 'Revise this slide excerpt so a first-time investor reader understands how Milo reaches its first customer.', decisions: [] });
    record.milo_pitch = miloResult;
    save();
    expect(String(miloResult.body.after).length).toBeGreaterThan(0);
    expect(String(miloResult.body.after)).not.toMatch(/\$\s?\d/);
  }, 240_000);

  it('drift_reviewer', async () => {
    const target = miloResult?.body ?? {};
    const result = await createHandlers().drift_reviewer({ ...base, task: driftReviewTask('live-check-milo-output', target), decisions: [proposedMiloPartner()] });
    record.drift_decision_status = 'proposed, not accepted';
    record.drift_reviewer = result;
    save();
    const { before: _input, ...asserted } = target as Record<string, unknown>;
    const leaves = JSON.stringify(asserted);
    for (const finding of result.body.findings as Array<{ excerpt: string }>) expect(leaves).toContain(JSON.stringify(finding.excerpt).slice(1, -1));
  }, 240_000);

  it('gym_operator', async () => {
    const realMirror = !!process.env.GYM_DATABASE_URL;
    const reader = realMirror ? gymReaderFromEnv() : await emptyGymShapes();
    const handlers = createHandlers({ gymReader: () => reader });
    const result = await handlers.gym_operator({ ...base, task: 'How many active individual members do we have per location, and how old is this data?', decisions: [] });
    record.gym_operator = { mode: realMirror ? 'real_mirror' : 'schema_only_no_data', ...result };
    save();
    expect(result.body).toHaveProperty('definition');
    expect(result.body).toHaveProperty('sql');
    expect(result.body).toHaveProperty('data_age_days');
  }, 240_000);
});
