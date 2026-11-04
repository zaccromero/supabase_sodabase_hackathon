// One real model call per profile. Runs only with AGENTS_LIVE=1, so `vitest run` stays offline.
// Writes what happened to AGENTS_LIVE_RECORD. Gym uses the real mirror through GYM_DATABASE_URL.
// Without it, gym runs against an empty copy of the real table shapes: this proves the model and
// tool loop only, returns no member numbers, and is recorded as schema_only_no_data.
import { writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import type { HandlerResult, PinnedDecision } from '../src/contract/types.js';
import { createHandlers, driftReviewTask } from '../src/agents/index.js';
import { gymReaderFromEnv, readerFromExecutor } from '../src/agents/gymReader.js';

const live = process.env.AGENTS_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;
const record: Record<string, unknown> = {};
const save = () => { if (process.env.AGENTS_LIVE_RECORD) writeFileSync(process.env.AGENTS_LIVE_RECORD, JSON.stringify(record, null, 2)); };
const base = { runId: 'live-check', attemptNo: 1 };

// Statement quoted from the finding example in docs/CONTRACT.md. Not a founder acceptance.
const contractExampleDecision: PinnedDecision = {
  id: '00000000-0000-4000-8000-000000000001',
  decision_key: 'milo.gym_nyc_partner',
  version: 1,
  statement: 'Describe Gym NYC as a partner.',
  source_uri: 'docs/CONTRACT.md#finding-example',
  source_historical: false,
};

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

  let miloResult: HandlerResult | undefined;
  it('milo_pitch', async () => {
    miloResult = await createHandlers().milo_pitch({ ...base, task: 'Tighten slide 07 so a first-time reader understands the go-to-market order. Keep the same steps.', decisions: [] });
    record.milo_pitch = miloResult;
    save();
    expect(String(miloResult.body.after).length).toBeGreaterThan(0);
    expect(String(miloResult.body.after)).not.toMatch(/\$\s?\d/);
  }, 240_000);

  it('drift_reviewer', async () => {
    const target = miloResult?.body ?? {};
    const result = await createHandlers().drift_reviewer({ ...base, task: driftReviewTask('live-check-milo-output', target), decisions: [contractExampleDecision] });
    record.drift_reviewer = result;
    save();
    const leaves = JSON.stringify(target);
    for (const finding of result.body.findings as Array<{ excerpt: string }>) expect(leaves).toContain(JSON.stringify(finding.excerpt).slice(1, -1));
  }, 240_000);
});
