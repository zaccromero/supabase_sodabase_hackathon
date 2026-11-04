// Test rows for the local test database. They are NOT company records.
// Each row goes through the same path the runner uses: the role that owns the
// write, the binding triggers, cm.request_completion. Nothing is inserted around
// the gate, so a blocked or completed status here was decided by the SQL. Every
// source URI starts with local-test:// and the screen says so.
// The shape follows src/runner (check ids, finding lifecycle, reviewer output).
import { createHash } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';

type Role = 'agent_worker' | 'evaluator_service' | 'gate_service' | 'founder_approver';
type Row = { id: string };
type Verdict = 'pass' | 'fail' | 'uncertain';
type Result = [check: string, verdict: Verdict, reason: string, evaluator: string];

const MILO_CHECKS = ['milo.no_forbidden_claim', 'milo.claims_sourced', 'critic.meaning'];
const GYM_CHECKS = ['gym.canonical_definition', 'gym.data_age_reported'];
const HISTORICAL_TEXT = "The founder's own gym: the first operations fee";
const HISTORICAL_LABEL = 'Local test row: historical draft excerpt. Not a new incident or current output.';

function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
const sha256 = (v: unknown) =>
  createHash('sha256').update(typeof v === 'string' ? v : canonicalJson(v)).digest('hex');

export async function writeLocalTestRows(db: PGlite): Promise<void> {
  const as = <T>(role: Role, fn: (tx: Transaction) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      return fn(tx);
    }) as Promise<T>;
  const one = async (tx: Transaction, sql: string, params: unknown[] = []) =>
    (await tx.query<Row>(sql, params)).rows[0] as Row;

  const source = (kind: string, uri: string, title: string, historical = false) =>
    as('gate_service', (tx) =>
      one(tx, `insert into cm.sources (kind, uri, title, content_sha256, historical) values ($1,$2,$3,$4,$5) returning id`,
        [kind, uri, title, sha256(uri), historical]));

  const propose = (key: string, version: number, statement: string, scope: string[], sourceId: string, by: string, supersedes?: string) =>
    as('gate_service', (tx) =>
      one(tx, `insert into cm.decisions (decision_key, version, statement, scope, source_id, proposed_by, supersedes_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [key, version, statement, scope, sourceId, by, supersedes ?? null]));

  // Same steps as acceptDecision in src/runner/fresh.ts.
  const accept = (id: string, key: string) =>
    as('founder_approver', async (tx) => {
      await tx.query(`update cm.decisions set status='superseded' where decision_key=$1 and status='accepted'`, [key]);
      await tx.query(`update cm.decisions set status='accepted', accepted_by='local-test', accepted_at=now() where id=$1`, [id]);
      await tx.query(`update cm.findings set status='corrected' where correction_decision_id=$1 and status='open'`, [id]);
    });

  const gate = (run: string) =>
    as('gate_service', (tx) => tx.query(`select cm.request_completion($1)`, [run]));

  interface RunSpec {
    profile: 'gym_operator' | 'milo_pitch' | 'drift_reviewer';
    task: string;
    checks: string[];
    pins?: string[];
    memory?: 'on' | 'baseline';
    technique?: string;
    budget?: number;
  }

  const startRun = (spec: RunSpec) =>
    as('gate_service', async (tx) => {
      const run = await one(tx, `insert into cm.runs (profile, task, status, memory_mode, technique_id, repair_budget) values ($1,$2,'running',$3,$4,$5) returning id`,
        [spec.profile, spec.task, spec.memory ?? 'on', spec.technique ?? null, spec.budget ?? 2]);
      for (const d of spec.pins ?? []) {
        await tx.query(`insert into cm.run_decisions (run_id, decision_id) values ($1,$2)`, [run.id, d]);
      }
      const contract = await one(tx, `insert into cm.check_contracts (run_id) values ($1) returning id`, [run.id]);
      for (const check of spec.checks) {
        await tx.query(`insert into cm.contract_checks (contract_id, check_id, kind) values ($1,$2,'deterministic')`, [contract.id, check]);
      }
      const hash = sha256(spec.checks);
      await tx.query(`update cm.check_contracts set contract_sha256=$1, frozen_at=now() where id=$2`, [hash, contract.id]);
      return { run: run.id, contract: contract.id, hash };
    });

  type Started = Awaited<ReturnType<typeof startRun>>;

  const attempt = async (r: Started, no: number, kind: 'initial' | 'repair', body: Record<string, unknown>, results: Result[], historical = false) => {
    const a = await as('gate_service', (tx) =>
      one(tx, `insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,$3,$4) returning id`, [r.run, r.contract, no, kind]));
    const outputSha = sha256(body);
    const output = await as('agent_worker', async (tx) => {
      const o = await one(tx, `insert into cm.outputs (attempt_id, body, output_sha256) values ($1,$2,$3) returning id`, [a.id, JSON.stringify(body), outputSha]);
      await tx.query(`insert into cm.evidence (output_id, kind, payload, created_by) values ($1,'hermes_transport',$2,'agent_worker')`,
        [o.id, JSON.stringify({ purpose: 'local test row', receipt: { served_model: 'local-test-model' } })]);
      if (historical) {
        await tx.query(`insert into cm.evidence (output_id, kind, uri, payload, created_by) values ($1,'slide_source','local-test://slide-packet',$2,'agent_worker')`,
          [o.id, JSON.stringify({ historical: true, historical_label: HISTORICAL_LABEL })]);
      }
      return o;
    });
    await as('evaluator_service', async (tx) => {
      for (const [check, verdict, reason, evaluator] of results) {
        const payload = { check_id: check, verdict, reason, test_row: true };
        const ev = await one(tx, `insert into cm.evidence (output_id, kind, sha256, payload, created_by) values ($1,'behavioral_evaluation',$2,$3,$4) returning id`,
          [output.id, sha256(payload), JSON.stringify(payload), evaluator]);
        await tx.query(
          `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'1',$9,$10,$11)`,
          [r.run, a.id, output.id, r.contract, check, outputSha, r.hash, evaluator, verdict, reason, ev.id]);
      }
    });
    return { attempt: a.id, output: output.id };
  };

  const fileFinding = (reviewRun: string, target: string, decision: string, excerpt: string, explanation: string, repair: string) =>
    as('evaluator_service', (tx) =>
      one(tx, `insert into cm.findings (reviewer_run_id, target_output_id, decision_id, excerpt, explanation, proposed_repair) values ($1,$2,$3,$4,$5,$6) returning id`,
        [reviewRun, target, decision, excerpt, explanation, repair]));

  const linkCorrection = (finding: string, decision: string) =>
    as('evaluator_service', (tx) =>
      tx.query(`update cm.findings set correction_decision_id=$1 where id=$2`, [decision, finding]));

  // Decisions and their sources.
  const partnerSource = await source('owner_note', 'local-test://owner-note/gym-nyc-partner', 'Local test source: Gym NYC relationship');
  const definitionSource = await source('repo_file', 'local-test://repo/member-contract.ts', 'Local test source: member definition');
  const reelSource = await source('reel', 'local-test://reel/open-on-the-question', 'Local test source: reel technique');
  await source('historical_artifact', 'local-test://deck/historical-slide', 'Local test source: historical slide', true);

  const partnerV1 = await propose('milo.gym_nyc_partner', 1, "Gym NYC is a partner, not the founder's gym; equity ownership is unconfirmed.", ['milo_pitch'], partnerSource.id, 'local-test');
  await accept(partnerV1.id, 'milo.gym_nyc_partner');
  const definition = await propose('gym.active_individual_definition', 1, 'Count active individual members as one client-backed MATCHED_INDIVIDUAL row from the latest complete official projection. Do not substitute churned_at IS NULL.', ['gym_operator'], definitionSource.id, 'local-test');
  await accept(definition.id, 'gym.active_individual_definition');

  // Memory off: the baseline repeats the old wording, the gate rejects it, and it gets no repairs.
  const task = 'Revise this historical slide excerpt using accepted decisions.';
  const baseline = await startRun({ profile: 'milo_pitch', task, checks: MILO_CHECKS, memory: 'baseline', budget: 0 });
  const drifted = await attempt(baseline, 1, 'initial',
    { slide_id: 'local-test-slide', before: HISTORICAL_TEXT, after: "The founder's own gym was the source of the first operations fee.", claims: [{ text: 'Operations fee', source: 'local-test://deck/historical-slide' }] },
    [
      ['milo.no_forbidden_claim', 'fail', 'Forbidden claim conflicts with accepted decision milo.gym_nyc_partner.', 'det.milo_rules'],
      ['milo.claims_sourced', 'uncertain', 'Claim source is not a pinned or allowed source.', 'det.milo_claims'],
      ['critic.meaning', 'fail', 'The output says the gym is the founder\'s own. The decision says partner.', 'critic.meaning'],
    ], true);
  await gate(baseline.run);
  await as('gate_service', (tx) => tx.query(`update cm.runs set status='failed' where id=$1`, [baseline.run]));

  // The reviewer files the finding against that output and proposes the next version.
  const finding1 = { excerpt: "The founder's own gym was the source of the first operations fee.", explanation: 'Conflicts with accepted decision milo.gym_nyc_partner v1', repair: 'Say Gym NYC, a partner, is the reported source of the fee' };
  const reviewRun = await startRun({ profile: 'drift_reviewer', task: JSON.stringify({ target_output_id: drifted.output }), checks: ['drift.findings_cited'] });
  await attempt(reviewRun, 1, 'initial',
    { target_output_id: drifted.output, findings: [finding1], decisions_reviewed: 2, proposed_only: true },
    [['drift.findings_cited', 'pass', 'The excerpt appears verbatim in the reviewed output.', 'det.drift_cited']]);
  await gate(reviewRun.run);
  const finding = await fileFinding(reviewRun.run, drifted.output, partnerV1.id, finding1.excerpt, finding1.explanation, finding1.repair);

  const partnerV2 = await propose('milo.gym_nyc_partner', 2, "Gym NYC is a partner, not the founder's gym. Say so whenever the operations fee comes up.", ['milo_pitch'], partnerSource.id, 'drift_reviewer', partnerV1.id);
  await linkCorrection(finding.id, partnerV2.id);
  await accept(partnerV2.id, 'milo.gym_nyc_partner');

  // A memory-on run blocked once and repaired, with a correction still waiting on the founder.
  const repaired = await startRun({ profile: 'milo_pitch', task: 'Revise the partner line on the opening slide.', checks: MILO_CHECKS, pins: [partnerV2.id] });
  const firstTry = await attempt(repaired, 1, 'initial',
    { slide_id: 'local-test-slide-b', before: 'Milo trains members at Gym NYC.', after: 'Milo was built at Gym NYC, which the founder runs.', claims: [] },
    [
      ['milo.no_forbidden_claim', 'pass', 'No listed wording found.', 'det.milo_rules'],
      ['milo.claims_sourced', 'pass', 'No claims to source.', 'det.milo_claims'],
      ['critic.meaning', 'fail', 'Implies the founder runs Gym NYC. The decision says partner.', 'critic.meaning'],
    ]);
  await gate(repaired.run);
  const openFinding = await fileFinding(reviewRun.run, firstTry.output, partnerV2.id, 'which the founder runs', 'Implies ownership the decision does not allow', 'Name Gym NYC as a partner in the first sentence');
  await attempt(repaired, 2, 'repair',
    { slide_id: 'local-test-slide-b', before: 'Milo was built at Gym NYC, which the founder runs.', after: 'Milo was built with Gym NYC, our partner.', claims: [] },
    [
      ['milo.no_forbidden_claim', 'pass', 'No listed wording found.', 'det.milo_rules'],
      ['milo.claims_sourced', 'pass', 'No claims to source.', 'det.milo_claims'],
      ['critic.meaning', 'pass', 'Says partner, with no claim of ownership.', 'critic.meaning'],
    ]);
  await gate(repaired.run);
  const partnerV3 = await propose('milo.gym_nyc_partner', 3, "Name Gym NYC as a partner in the first sentence. Never as the founder's gym.", ['milo_pitch'], partnerSource.id, 'drift_reviewer', partnerV2.id);
  await linkCorrection(openFinding.id, partnerV3.id);

  // Fresh run: new run, pinned correction, no notes from the failure.
  const fresh = await startRun({ profile: 'milo_pitch', task, checks: MILO_CHECKS, pins: [partnerV2.id] });
  await attempt(fresh, 1, 'initial',
    { slide_id: 'local-test-slide', before: HISTORICAL_TEXT, after: 'Start with a partner.\nGym NYC is the reported source of the first operations fee.', claims: [{ text: 'Gym NYC relationship', source: 'local-test://owner-note/gym-nyc-partner' }] },
    [
      ['milo.no_forbidden_claim', 'pass', 'No forbidden wording in the revised slide.', 'det.milo_rules'],
      ['milo.claims_sourced', 'pass', 'Every claim names an allowed source.', 'det.milo_claims'],
      ['critic.meaning', 'pass', 'The revision follows milo.gym_nyc_partner v2.', 'critic.meaning'],
    ], true);
  await gate(fresh.run);
  await as('evaluator_service', (tx) =>
    tx.query(`update cm.findings set verifying_run_id=$1 where id=$2`, [fresh.run, finding.id]));
  await as('evaluator_service', (tx) =>
    tx.query(`update cm.findings set status='verified' where id=$1`, [finding.id]));

  // Gym question with data age. A count the test row does not have stays unknown.
  const asOf = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const gymBody = { answer: [{ location_id: 'local-test', active_individual_members: null }], definition: 'MATCHED_INDIVIDUAL, latest complete projection', data_as_of: asOf, data_age_days: 2, sql: 'local test row' };
  const gymRun = await startRun({ profile: 'gym_operator', task: 'How many active individual members does this location have?', checks: GYM_CHECKS, pins: [definition.id] });
  await attempt(gymRun, 1, 'initial', gymBody, [
    ['gym.canonical_definition', 'pass', 'Query uses MATCHED_INDIVIDUAL against the latest complete projection.', 'det.gym_definition'],
    ['gym.data_age_reported', 'pass', 'Reported age matches the data_as_of value.', 'det.gym_freshness'],
  ]);
  await gate(gymRun.run);

  const uncertainRun = await startRun({ profile: 'gym_operator', task: 'Did this location lose members after the projection refresh?', checks: GYM_CHECKS, pins: [definition.id] });
  await attempt(uncertainRun, 1, 'initial', gymBody, [
    ['gym.canonical_definition', 'uncertain', 'Projection window overlaps the refresh. The evaluator cannot settle it from the output alone.', 'critic.gym_reasoning'],
    ['gym.data_age_reported', 'pass', 'Reported age matches the data_as_of value.', 'det.gym_freshness'],
  ]);
  await gate(uncertainRun.run);

  // Reel: a proposed decision waiting on the founder, and a run through the same gate.
  await propose('milo.open_on_the_question', 1, 'Open the pitch on the question, not on the product.', ['milo_pitch'], reelSource.id, 'reel_extractor');
  const technique = await as('gate_service', (tx) =>
    one(tx, `insert into cm.techniques (source_id, media_sha256, model, prompt_sha256, extraction) values ($1,$2,'local-test',$3,$4) returning id`,
      [reelSource.id, sha256('local-test-media'), sha256('local-test-prompt'), JSON.stringify({ technique: 'Open on the question', test_row: true })]));
  const reelRun = await startRun({ profile: 'milo_pitch', task: 'Apply the reel technique to the opening slide.', checks: MILO_CHECKS, pins: [partnerV2.id], technique: technique.id });
  await attempt(reelRun, 1, 'initial',
    { slide_id: 'local-test-slide-d', before: 'Milo is an AI trainer.', after: 'Why does your trainer forget you between sessions?', claims: [] },
    [
      ['milo.no_forbidden_claim', 'pass', 'No listed wording found.', 'det.milo_rules'],
      ['milo.claims_sourced', 'pass', 'No claims to source.', 'det.milo_claims'],
      ['critic.meaning', 'pass', 'Technique applied. The slide still follows accepted decisions.', 'critic.meaning'],
    ]);
  await gate(reelRun.run);

  // Data-quality rows sit in their own table and never feed the gate.
  await as('evaluator_service', async (tx) => {
    for (const [table, verdict, problem, count, severity] of [
      ['local_test.member_projection', 'fail', 'Local test row: duplicate member keys', 1, 'high'],
      ['local_test.location_daily', 'pass', null, 0, null],
    ] as const) {
      await tx.query(`insert into cm.quality_findings (provider, provider_finding_id, table_name, verdict, problem, finding_count, severity, raw) values ('local-test',$1,$2,$3,$4,$5,$6,$7)`,
        [`local-test-${table}`, table, verdict, problem, count, severity, JSON.stringify({ test_row: true })]);
    }
  });
}
