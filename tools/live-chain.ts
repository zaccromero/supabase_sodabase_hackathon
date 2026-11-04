// The live chain on the hosted database, Hermes only: baseline, drift review, gate rejection, link to the accepted
// decision, fresh verifying run. A separate --gym step runs the operator and compares it with the recorded counts.
// It writes one receipt per step and never approves anything. A finding exists only if the review found real drift.
//
// doppler run -p hackathon -c dev -- tsx tools/live-chain.ts          (steps 1 to 5)
// doppler run -p hackathon -c dev -- tsx tools/live-chain.ts --gym    (step 6)
// doppler run -p hackathon -c dev -- tsx tools/live-chain.ts --historical-replay   (steps 1 to 5, labeled replay at step 1)
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Handler, Profile } from '../src/contract/types';
import { retrieveAccepted } from '../src/memory/index';
import { linkAcceptedCorrection, pgDb, runAgent, verifyFresh, type RunReport } from '../src/runner/index';
import { liveBinding, reviewOutput } from '../src/runner/live';

const root = new URL('..', import.meta.url).pathname;
const db = pgDb();
const PARTNER_DECISION = '0cb43524-2f09-5427-89cb-67614535bee0'; // milo.gym_nyc_partner v1, accepted by the owner.
const MILO_TASK = 'Revise this slide excerpt for the current pitch. Return only the title and body. No financial figures or usage claims.';
const GYM_TASK = 'How many active individual members does each location have right now, and how current is that data?';
const GYM_TIMEBOX_MS = 8 * 60_000;
const REPLAY_TASK = 'HISTORICAL REPLAY, not a model output: the historical slide line from the source packet, put through the normal checks.';

/**
 * Returns the packet's real historical line unchanged, and makes no model call. The body says what it is. The packet's
 * label calling the claim superseded stays in evidence, because the reviewer reads the body and must judge it unprompted.
 */
const replayHandler: Handler = async () => {
  const raw = readFileSync(`${root}data/curated/milo-slide-text.json`);
  const packet = JSON.parse(raw.toString('utf8'));
  const text: string = packet.historical_input.text;
  return {
    body: {
      slide_id: packet.id, before: text, after: text,
      claims: [{ text, source: packet.historical_input.source_id }],
      provenance: { kind: 'historical_replay', model_generated: false, source_id: packet.historical_input.source_id },
    },
    evidence: [{
      kind: 'slide_source', uri: 'data/curated/milo-slide-text.json', sha256: createHash('sha256').update(raw).digest('hex'),
      payload: { packet_id: packet.id, distribution: packet.distribution, source_id: packet.historical_input.source_id, historical_label: packet.historical_input.label, historical: true, model_generated: false },
    }],
  };
};
const sourceHead = execSync('git rev-parse HEAD', { cwd: root }).toString().trim();
const clean = execSync('git status --porcelain -- src tools supabase', { cwd: root }).toString().trim() === '';

const read = <T = any>(sql: string, params: unknown[]) => db.withRole('dashboard_reader', (tx) => tx.query<T>(sql, params));

/** Same fields as the fresh-milo receipt, plus the step and whatever that step showed. */
async function writeReceipt(step: string, started: string, profile: Profile, report: RunReport | null, extra: Record<string, unknown>) {
  const id = report?.run_id;
  const receipt = {
    step,
    environment: 'hosted Supabase, project dgqcanfiapxztmqqlqnh',
    transport: 'hermes_oauth',
    source_head: sourceHead,
    source_clean: clean,
    started,
    finished: new Date().toISOString(),
    accepted_for_profile: (await retrieveAccepted(db, profile)).map((d) => `${d.decision_key}@${d.version}`),
    ...(report ? {
      run_id: id, memory_mode: report.memory_mode, status: report.status, failure_reason: report.failure_reason ?? null, contract_sha256: report.contract_sha256,
      pinned: await read(`select d.id, d.decision_key, d.version, d.status, d.accepted_at, rd.pinned_at from cm.run_decisions rd join cm.decisions d on d.id = rd.decision_id where rd.run_id = $1 order by 2`, [id]),
      outputs: await read(`select o.id, a.attempt_no, a.kind, o.output_sha256, o.body from cm.outputs o join cm.attempts a on a.id = o.attempt_id where a.run_id = $1 order by 2`, [id]),
      evidence: await read(`select e.id, e.output_id, e.kind, e.sha256, e.payload, e.created_by from cm.evidence e join cm.outputs o on o.id = e.output_id join cm.attempts a on a.id = o.attempt_id where a.run_id = $1 order by e.created_at`, [id]),
      evaluations: await read(`select id, attempt_id, output_id, check_id, verdict, reason, evaluator, evaluator_version, evidence_id, output_sha256, contract_sha256 from cm.evaluations where run_id = $1 order by created_at`, [id]),
      gate_decisions: await read(`select verdict, missing, attempt_id, created_at from cm.gate_decisions where run_id = $1 order by created_at`, [id]),
      attempt_errors: report.attempts.map((a) => ({ attempt_no: a.attempt_no, handler_error: a.handler_error ?? null, evaluator_errors: a.evaluator_errors })),
    } : {}),
    ...extra,
  };
  mkdirSync(`${root}docs/receipts`, { recursive: true });
  const path = `docs/receipts/live-chain-${step}-${started.replace(/[:.]/g, '-')}.json`;
  writeFileSync(`${root}${path}`, JSON.stringify(receipt, null, 2));
  console.log(`\n## ${step}: ${path}`);
  return path;
}

const brief = (r: RunReport) => ({
  run: r.run_id, status: r.status, mode: r.memory_mode, failure: r.failure_reason, pinned: r.pinned.map((d) => `${d.decision_key}@${d.version}`),
  attempts: r.attempts.map((a) => ({
    n: a.attempt_no, kind: a.kind, handler_error: a.handler_error, evaluator_errors: a.evaluator_errors,
    evals: a.evaluations.map((e) => [e.check_id, e.verdict, e.reason.slice(0, 200)]), gate: a.gate.verdict, missing: a.gate.missing.map((m) => [m.check_id, m.reason]),
  })),
});
const say = (v: unknown) => console.log(JSON.stringify(v, null, 1));
const now = () => new Date().toISOString();
const stop = async (message: string): Promise<never> => { console.log(`STOP: ${message}`); await db.close(); process.exit(0); };

async function miloChain() {
  // Step 1: no memory, same checks. With --historical-replay the output is the real historical line, not a generation.
  let started = now();
  const replay = process.argv.includes('--historical-replay');
  const baseline = await runAgent(db, replay
    ? { profile: 'milo_pitch', task: REPLAY_TASK, memoryMode: 'baseline', binding: { ...liveBinding(db, 'milo_pitch'), handler: replayHandler } }
    : { profile: 'milo_pitch', task: MILO_TASK, memoryMode: 'baseline', binding: liveBinding(db, 'milo_pitch') });
  const output = baseline.attempts[0]?.output_id;
  const body = output ? (await read(`select body from cm.outputs where id = $1`, [output]))[0].body : null;
  await writeReceipt(replay ? '1-historical-replay' : '1-baseline', started, 'milo_pitch', baseline, replay
    ? { label: 'HISTORICAL REPLAY: the output is a real historical slide line, not a model generation. Approved by the owner. Only the critic used a model in this step.', transport: 'none for the replayed output; hermes_oauth for the critic' }
    : { label: 'memory_mode=baseline: no decisions given to the handler; evaluators judge against accepted memory' });
  say({ ...brief(baseline), output: body });
  if (!output) return stop('baseline produced no output; evidence kept');

  // Step 2: the reviewer decides whether this conflicts. Nothing is staged if it does not.
  started = now();
  const review = await reviewOutput(db, { targetOutputId: output, binding: liveBinding(db, 'drift_reviewer') });
  const findings = review.finding_ids.length ? await read(`select id, decision_id, excerpt, explanation, proposed_repair, status from cm.findings where id::text = any($1::text[])`, [review.finding_ids]) : [];
  await writeReceipt('2-drift-review', started, 'drift_reviewer', review.report, { target_output_id: output, findings });
  say({ ...brief(review.report), findings });
  if (review.report.status !== 'completed') return stop(`drift review ended ${review.report.status}; no finding recorded`);
  if (!findings.length) return stop('the reviewer found no conflict in the baseline output; no finding staged');

  // Step 3: the gate's own record for that output, and a direct attempt to complete past it.
  started = now();
  const verdicts = await read(`select verdict, missing, created_at from cm.gate_decisions where run_id = $1 order by created_at`, [baseline.run_id]);
  let direct = 'NOT_REJECTED';
  try {
    await db.withRole('gate_service', (tx) => tx.query(`update cm.runs set status = 'completed' where id = $1::uuid`, [baseline.run_id]));
  } catch (err) {
    direct = err instanceof Error ? err.message : String(err);
  }
  await writeReceipt('3-gate-rejection', started, 'milo_pitch', baseline, { direct_completion_attempt: direct, gate_verdicts_for_output: verdicts, run_status_after_attempt: (await read(`select status from cm.runs where id = $1`, [baseline.run_id]))[0].status });
  say({ gate: verdicts.map((v: any) => [v.verdict, v.missing.map((m: any) => [m.check_id, m.reason])]), direct_completion_attempt: direct.slice(0, 200) });

  // Step 4: link, with no new statement or version. Only a finding that cites the partner decision qualifies.
  started = now();
  const finding = findings.find((f: any) => f.decision_id === PARTNER_DECISION);
  if (!finding) {
    await writeReceipt('4-link', started, 'milo_pitch', null, { linked: false, reason: 'no finding cites milo.gym_nyc_partner v1', findings });
    return stop('no finding cites milo.gym_nyc_partner v1; nothing linked');
  }
  await linkAcceptedCorrection(db, { findingId: finding.id, decisionId: PARTNER_DECISION });
  const chain = (await read(`select status, decision_key, decision_version, excerpt, correction_decision_id, verifying_run_id from cm.v_finding_chain where finding_id = $1`, [finding.id]))[0];
  const versions = await read(`select version, status, accepted_by from cm.decisions where decision_key = 'milo.gym_nyc_partner' order by version`, []);
  await writeReceipt('4-link', started, 'milo_pitch', null, { linked: true, finding_id: finding.id, finding_chain: chain, decision_versions: versions });
  say({ chain, versions });

  // Step 5: a new run with no parent or notes. The finding settles as verified only if this run completes.
  started = now();
  const fresh = await verifyFresh(db, { findingId: finding.id, profile: 'milo_pitch', task: MILO_TASK, binding: liveBinding(db, 'milo_pitch') });
  const after = (await read(`select status, decision_key, decision_version, excerpt, correction_decision_id, verifying_run_id, verifying_run_status from cm.v_finding_chain where finding_id = $1`, [finding.id]))[0];
  const freshRow = (await read(`select parent_run_id, memory_mode from cm.runs where id = $1`, [fresh.verifying_run_id]))[0];
  const last = fresh.report.attempts.at(-1)?.output_id;
  await writeReceipt('5-verify-fresh', started, 'milo_pitch', fresh.report, { finding_id: finding.id, verified: fresh.verified, finding_chain: after, parent_run_id: freshRow.parent_run_id });
  say({ verified: fresh.verified, ...brief(fresh.report), output: last ? (await read(`select body from cm.outputs where id = $1`, [last]))[0].body : null, chain: after, parent_run_id: freshRow.parent_run_id });
}

async function gymRun() {
  const started = now();
  const recordedFile = readdirSync(`${root}docs/receipts`).filter((f) => f.startsWith('gym-active-members-')).sort().at(-1)!;
  const recorded = JSON.parse(readFileSync(`${root}docs/receipts/${recordedFile}`, 'utf8'));
  let runId: string | undefined;
  const timer = setTimeout(async () => {
    console.log(`STOP: gym run exceeded ${GYM_TIMEBOX_MS / 60000} minutes`);
    if (runId) await db.withRole('gate_service', (tx) => tx.query(`update cm.runs set status = 'failed' where id = $1::uuid`, [runId])).catch(() => {});
    process.exit(1);
  }, GYM_TIMEBOX_MS);
  const report = await runAgent(db, { profile: 'gym_operator', task: GYM_TASK, binding: liveBinding(db, 'gym_operator'), onRunCreated: async (id) => { runId = id; } });
  clearTimeout(timer);
  const output = report.attempts.at(-1)?.output_id;
  const body: any = output ? (await read(`select body from cm.outputs where id = $1`, [output]))[0].body : null;
  const expected = Object.fromEntries(recorded.locations.map((l: any) => [l.location_id, { state: l.state, active_individual_members: l.active_individual_members }]));
  const answered = Object.fromEntries((body?.answer ?? []).map((a: any) => [a.location_id, a.active_individual_members ?? null]));
  const comparison = Object.entries(expected).map(([location_id, e]: [string, any]) => ({
    location_id, recorded_state: e.state, recorded: e.active_individual_members, answered: answered[location_id] ?? null,
    match: e.active_individual_members === null ? null : e.active_individual_members === (answered[location_id] ?? null),
  }));
  await writeReceipt('6-gym-operator', started, 'gym_operator', report, { compared_with: `docs/receipts/${recordedFile}`, comparison, answer_definition: body?.definition ?? null, data_as_of: body?.data_as_of ?? null, data_age_days: body?.data_age_days ?? null });
  say({ ...brief(report), comparison, definition: body?.definition, data_as_of: body?.data_as_of, data_age_days: body?.data_age_days });
}

try {
  await (process.argv.includes('--gym') ? gymRun() : miloChain());
} catch (err) {
  console.log(`ERROR: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
process.exit();
