// Test rows for the local test database. They are NOT company records.
// Each row goes through the same path the contract gives the real lanes: the
// role that owns the write, the binding triggers, cm.request_completion. Nothing
// is inserted around the gate, so a blocked or completed status here was decided
// by the SQL. Every source URI starts with local-test:// and the screen says so.
import { createHash } from 'node:crypto';
import type { PGlite, Transaction } from '@electric-sql/pglite';

type Role = 'agent_worker' | 'evaluator_service' | 'gate_service' | 'founder_approver';
type Row = { id: string };
type Verdict = 'pass' | 'fail' | 'uncertain';

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

  const accept = (id: string) =>
    as('founder_approver', (tx) =>
      tx.query(`update cm.decisions set status='accepted', accepted_by='local-test', accepted_at=now() where id=$1`, [id]));

  const gate = (run: string) =>
    as('gate_service', (tx) => tx.query(`select cm.request_completion($1)`, [run]));

  interface RunSpec {
    profile: 'gym_operator' | 'milo_pitch' | 'drift_reviewer';
    task: string;
    check: string;
    decision?: string;
    pins?: string[];
    memory?: 'on' | 'baseline';
    technique?: string;
  }

  const startRun = (spec: RunSpec) =>
    as('gate_service', async (tx) => {
      const run = await one(tx, `insert into cm.runs (profile, task, status, memory_mode, technique_id) values ($1,$2,'running',$3,$4) returning id`,
        [spec.profile, spec.task, spec.memory ?? 'on', spec.technique ?? null]);
      for (const d of spec.pins ?? []) {
        await tx.query(`insert into cm.run_decisions (run_id, decision_id) values ($1,$2)`, [run.id, d]);
      }
      const contract = await one(tx, `insert into cm.check_contracts (run_id) values ($1) returning id`, [run.id]);
      await tx.query(`insert into cm.contract_checks (contract_id, check_id, kind, decision_id) values ($1,$2,'deterministic',$3)`,
        [contract.id, spec.check, spec.decision ?? null]);
      const hash = sha256([{ check_id: spec.check }]);
      await tx.query(`update cm.check_contracts set contract_sha256=$1, frozen_at=now() where id=$2`, [hash, contract.id]);
      return { run: run.id, contract: contract.id, hash, check: spec.check };
    });

  type Started = Awaited<ReturnType<typeof startRun>>;

  const attempt = async (r: Started, no: number, kind: 'initial' | 'repair', body: Record<string, unknown>, verdict: Verdict, reason: string, evaluator: string) => {
    const a = await as('gate_service', (tx) =>
      one(tx, `insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,$3,$4) returning id`, [r.run, r.contract, no, kind]));
    const outputSha = sha256(body);
    const output = await as('agent_worker', (tx) =>
      one(tx, `insert into cm.outputs (attempt_id, body, output_sha256) values ($1,$2,$3) returning id`, [a.id, JSON.stringify(body), outputSha]));
    await as('evaluator_service', async (tx) => {
      const ev = await one(tx, `insert into cm.evidence (output_id, kind, uri, sha256, payload, created_by) values ($1,'evaluator_result',$2,$3,$4,$5) returning id`,
        [output.id, `local-test://evidence/${r.check}/${no}`, outputSha, JSON.stringify({ test_row: true }), evaluator]);
      await tx.query(
        `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'1',$9,$10,$11)`,
        [r.run, a.id, output.id, r.contract, r.check, outputSha, r.hash, evaluator, verdict, reason, ev.id]);
    });
    return { attempt: a.id, output: output.id };
  };

  // Decisions and their sources.
  const partnerSource = await source('owner_note', 'local-test://owner-note/gym-nyc-partner', 'Local test source: Gym NYC relationship');
  const definitionSource = await source('historical_artifact', 'local-test://repo/gym-definition.md', 'Local test source: member definition', true);
  const reelSource = await source('reel', 'local-test://reel/open-on-the-question', 'Local test source: reel technique');

  const partnerV1 = await propose('milo.gym_nyc_partner', 1, 'Describe Gym NYC as a partner of Milo.', ['milo_pitch'], partnerSource.id, 'local-test');
  await accept(partnerV1.id);
  const definition = await propose('gym.canonical_definition', 1, 'An active individual member is MATCHED_INDIVIDUAL in the latest complete projection.', ['gym_operator'], definitionSource.id, 'local-test');
  await accept(definition.id);

  // The Milo slide conflicts, the gate rejects it, a repair passes.
  const slideRun = await startRun({ profile: 'milo_pitch', task: 'Revise the partner slide in the Milo deck', check: 'milo.partner_wording', decision: partnerV1.id, pins: [partnerV1.id] });
  const before = 'Milo trains members at Gym NYC.';
  const conflicting = await attempt(slideRun, 1, 'initial',
    { slide_id: 'local-test-slide', before, after: "Milo runs inside the founder's own gym.", claims: [{ text: 'Gym NYC relationship', source: 'local-test://owner-note/gym-nyc-partner' }] },
    'fail', 'Slide calls Gym NYC the founder\'s own gym. Accepted decision says partner.', 'critic.drift');
  await gate(slideRun.run);

  // The reviewer files the finding against the conflicting output.
  const reviewRun = await startRun({ profile: 'drift_reviewer', task: 'Review the partner slide against accepted decisions', check: 'drift.reviewed', pins: [partnerV1.id] });
  await attempt(reviewRun, 1, 'initial', { reviewed_output: conflicting.output, findings: 1 }, 'pass', 'Reviewer read the output and filed one finding.', 'det.reviewer_complete');
  await gate(reviewRun.run);
  const finding = await as('evaluator_service', (tx) =>
    one(tx, `insert into cm.findings (reviewer_run_id, target_output_id, decision_id, excerpt, explanation, proposed_repair) values ($1,$2,$3,$4,$5,$6) returning id`,
      [reviewRun.run, conflicting.output, partnerV1.id, "the founder's own gym", 'Conflicts with accepted decision milo.gym_nyc_partner v1', 'Describe Gym NYC as a partner']));

  await attempt(slideRun, 2, 'repair',
    { slide_id: 'local-test-slide', before: "Milo runs inside the founder's own gym.", after: 'Milo runs with Gym NYC, our partner.', claims: [{ text: 'Gym NYC relationship', source: 'local-test://owner-note/gym-nyc-partner' }] },
    'pass', 'Slide says partner. No conflict with the accepted decision.', 'critic.drift');
  await gate(slideRun.run);

  // The correction becomes a new accepted version, then a fresh run has to follow it.
  const partnerV2 = await propose('milo.gym_nyc_partner', 2, "Describe Gym NYC as a partner of Milo. Never as the founder's own gym.", ['milo_pitch'], partnerSource.id, 'drift_reviewer', partnerV1.id);
  await as('founder_approver', async (tx) => {
    await tx.query(`update cm.decisions set status='superseded' where id=$1`, [partnerV1.id]);
    await tx.query(`update cm.decisions set status='accepted', accepted_by='local-test', accepted_at=now() where id=$1`, [partnerV2.id]);
    await tx.query(`update cm.findings set status='corrected', correction_decision_id=$1 where id=$2`, [partnerV2.id, finding.id]);
  });

  const baselineRun = await startRun({ profile: 'milo_pitch', task: 'Write a Gym NYC line for the investor slide, memory off', check: 'milo.partner_wording', memory: 'baseline' });
  await attempt(baselineRun, 1, 'initial',
    { slide_id: 'local-test-slide-b', before: '', after: "Tested first at the founder's own gym.", claims: [] },
    'fail', 'Without pinned decisions the run repeats the wording the founder corrected.', 'critic.drift');
  await gate(baselineRun.run);

  const freshRun = await startRun({ profile: 'milo_pitch', task: 'Revise this historical slide excerpt, fresh run', check: 'milo.partner_wording', decision: partnerV2.id, pins: [partnerV2.id] });
  await attempt(freshRun, 1, 'initial',
    { slide_id: 'local-test-slide-c', before: "The founder's own gym: the first operations fee", after: 'Tested first with our partner, Gym NYC.', claims: [{ text: 'Gym NYC relationship', source: 'local-test://owner-note/gym-nyc-partner' }] },
    'pass', 'Fresh run followed milo.gym_nyc_partner v2 with no repair notes.', 'critic.drift');
  await gate(freshRun.run);
  await as('founder_approver', (tx) =>
    tx.query(`update cm.findings set status='verified', verifying_run_id=$1 where id=$2`, [freshRun.run, finding.id]));

  // A second finding with a correction still waiting on the founder, so that state stays visible.
  const openFinding = await as('evaluator_service', (tx) =>
    one(tx, `insert into cm.findings (reviewer_run_id, target_output_id, decision_id, excerpt, explanation, proposed_repair) values ($1,(select o.id from cm.outputs o join cm.attempts a on a.id=o.attempt_id where a.run_id=$2 limit 1),$3,$4,$5,$6) returning id`,
      [reviewRun.run, baselineRun.run, partnerV2.id, "the founder's own gym", 'Memory-off run repeated the corrected wording', 'Name Gym NYC as a partner in the first sentence']));
  const partnerV3 = await propose('milo.gym_nyc_partner', 3, "Name Gym NYC as a partner in the first sentence. Never as the founder's own gym.", ['milo_pitch'], partnerSource.id, 'drift_reviewer', partnerV2.id);
  await as('evaluator_service', (tx) =>
    tx.query(`update cm.findings set correction_decision_id=$1 where id=$2`, [partnerV3.id, openFinding.id]));

  // Gym question with data age, then one the evaluator could not settle.
  const asOf = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const gymRun = await startRun({ profile: 'gym_operator', task: 'How many active individual members does Lex have?', check: 'gym.canonical_definition', decision: definition.id, pins: [definition.id] });
  await attempt(gymRun, 1, 'initial',
    { answer: [{ location_id: 'lex', active_individual_members: null }], definition: 'MATCHED_INDIVIDUAL, latest complete projection', data_as_of: asOf, data_age_days: 2, sql: 'local test row' },
    'pass', 'Query uses MATCHED_INDIVIDUAL against the latest complete projection.', 'det.gym_definition');
  await gate(gymRun.run);

  const uncertainRun = await startRun({ profile: 'gym_operator', task: 'Did Lex lose members after the projection refresh?', check: 'gym.canonical_definition', decision: definition.id, pins: [definition.id] });
  await attempt(uncertainRun, 1, 'initial',
    { answer: [{ location_id: 'lex', active_individual_members: null }], definition: 'MATCHED_INDIVIDUAL, latest complete projection', data_as_of: asOf, data_age_days: 2, sql: 'local test row' },
    'uncertain', 'Projection window overlaps the refresh. Evaluator cannot settle it from the output alone.', 'critic.gym_reasoning');
  await gate(uncertainRun.run);

  // Reel: proposed decision waiting on the founder, and a run through the same gate.
  await propose('milo.open_on_the_question', 1, 'Open the pitch on the question, not on the product.', ['milo_pitch'], reelSource.id, 'reel_extractor');
  const technique = await as('gate_service', (tx) =>
    one(tx, `insert into cm.techniques (source_id, media_sha256, model, prompt_sha256, extraction) values ($1,$2,'local-test',$3,$4) returning id`,
      [reelSource.id, sha256('local-test-media'), sha256('local-test-prompt'), JSON.stringify({ technique: 'Open on the question', test_row: true })]));
  const reelRun = await startRun({ profile: 'milo_pitch', task: 'Apply the reel technique to the opening slide', check: 'milo.partner_wording', decision: partnerV2.id, pins: [partnerV2.id], technique: technique.id });
  await attempt(reelRun, 1, 'initial',
    { slide_id: 'local-test-slide-d', before: 'Milo is an AI trainer.', after: 'Why does your trainer forget you between sessions?', claims: [] },
    'pass', 'Technique applied. Slide still follows the accepted decisions.', 'critic.drift');
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
