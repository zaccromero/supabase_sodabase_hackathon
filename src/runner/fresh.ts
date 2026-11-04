// A correction survives a fresh run: finding -> proposed version -> founder acceptance -> new run pins it.
import type { Profile } from '../contract/types';
import type { Db } from './db';
import { runAgent, type AgentBinding, type RunReport } from './run';

export interface NewFinding {
  targetOutputId: string;
  decisionId: string;
  excerpt: string;
  explanation: string;
  proposedRepair: string;
  reviewerRunId?: string;
}

export async function recordFinding(db: Db, f: NewFinding): Promise<string> {
  const [row] = await db.withRole('evaluator_service', (tx) => tx.query<{ id: string }>(
    `insert into cm.findings (reviewer_run_id, target_output_id, decision_id, excerpt, explanation, proposed_repair)
     values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) returning id`,
    [f.reviewerRunId ?? null, f.targetOutputId, f.decisionId, f.excerpt, f.explanation, f.proposedRepair],
  ));
  return row!.id;
}

/**
 * Moves what a drift review found into cm.findings. Only a review the gate completed counts, so a finding
 * the evaluators rejected never lands. Safe to call twice: a finding already recorded for this run is reused.
 */
export async function recordReviewFindings(db: Db, reviewerRunId: string): Promise<string[]> {
  return db.withRole('evaluator_service', async (tx) => {
    const [run] = await tx.query<{ profile: string; status: string; body: { target_output_id?: string; findings?: Array<Record<string, string>> } | null }>(
      `select r.profile, r.status, o.body
       from cm.runs r
       left join lateral (select id from cm.attempts a where a.run_id = r.id order by attempt_no desc limit 1) a on true
       left join cm.outputs o on o.attempt_id = a.id
       where r.id = $1::uuid`,
      [reviewerRunId],
    );
    if (!run) throw new Error(`RUN_NOT_FOUND: ${reviewerRunId}`);
    if (run.profile !== 'drift_reviewer') throw new Error(`NOT_A_REVIEW_RUN: ${run.profile}`);
    if (run.status !== 'completed') throw new Error(`REVIEW_NOT_COMPLETED: ${run.status}`);

    const ids: string[] = [];
    for (const f of run.body?.findings ?? []) {
      const target = f.target_output_id ?? run.body?.target_output_id;
      const [existing] = await tx.query<{ id: string }>(
        `select id from cm.findings where reviewer_run_id = $1::uuid and target_output_id = $2::uuid and decision_id = $3::uuid and excerpt = $4`,
        [reviewerRunId, target, f.decision_id, f.excerpt],
      );
      const [row] = existing ? [existing] : await tx.query<{ id: string }>(
        `insert into cm.findings (reviewer_run_id, target_output_id, decision_id, excerpt, explanation, proposed_repair)
         values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) returning id`,
        [reviewerRunId, target, f.decision_id, f.excerpt, f.explanation, f.proposed_repair],
      );
      ids.push(row!.id);
    }
    return ids;
  });
}

/**
 * Proposes the next version of the decision a finding cites. Nothing can pin it until a founder accepts it.
 * The finding stays 'open' with correction_decision_id set; it becomes 'corrected' on acceptance.
 * The statement defaults to the finding's proposed repair. The source records where the correction came from.
 */
export async function correct(db: Db, input: { findingId: string; proposedBy: string; statement?: string; sourceId?: string }): Promise<{ decisionId: string; version: number }> {
  return db.withRole('gate_service', async (tx) => {
    const [f] = await tx.query<{ status: string; proposed_repair: string; decision_id: string; decision_key: string; scope: string[]; correction_decision_id: string | null }>(
      `select f.status, f.proposed_repair, f.decision_id, f.correction_decision_id, d.decision_key, d.scope
       from cm.findings f join cm.decisions d on d.id = f.decision_id where f.id = $1::uuid`,
      [input.findingId],
    );
    if (!f) throw new Error(`FINDING_NOT_FOUND: ${input.findingId}`);
    if (f.status !== 'open') throw new Error(`FINDING_NOT_OPEN: ${f.status}`);
    if (f.correction_decision_id) throw new Error(`CORRECTION_ALREADY_PROPOSED: ${f.correction_decision_id}`);

    let sourceId = input.sourceId;
    if (!sourceId) {
      const [source] = await tx.query<{ id: string }>(
        `insert into cm.sources (kind, uri, title) values ('owner_note', $1, $2) returning id`,
        [`cm:finding/${input.findingId}`, `Correction of ${f.decision_key} from finding ${input.findingId}`],
      );
      sourceId = source!.id;
    }
    const [decision] = await tx.query<{ id: string; version: number }>(
      `insert into cm.decisions (decision_key, version, statement, scope, source_id, supersedes_id, proposed_by)
       select $1, coalesce(max(version), 0) + 1, $2, $3::text[], $4::uuid, $5::uuid, $6 from cm.decisions where decision_key = $1
       returning id, version`,
      [f.decision_key, input.statement ?? f.proposed_repair, f.scope, sourceId, f.decision_id, input.proposedBy],
    );
    // gate_service has no write on findings; evaluator_service does. Same transaction, so both land or neither.
    await tx.setRole('evaluator_service');
    await tx.query(`update cm.findings set correction_decision_id = $2::uuid where id = $1::uuid`, [input.findingId, decision!.id]);
    return { decisionId: decision!.id, version: decision!.version };
  });
}

/** Founder only. Supersedes the current version, accepts this one, and marks findings it corrects. */
export async function acceptDecision(db: Db, input: { decisionId: string; acceptedBy: string }): Promise<void> {
  await db.withRole('founder_approver', async (tx) => {
    const [d] = await tx.query<{ decision_key: string; status: string }>(`select decision_key, status from cm.decisions where id = $1::uuid`, [input.decisionId]);
    if (!d) throw new Error(`DECISION_NOT_FOUND: ${input.decisionId}`);
    if (d.status !== 'proposed') throw new Error(`DECISION_NOT_PROPOSED: ${d.status}`);
    await tx.query(`update cm.decisions set status = 'superseded' where decision_key = $1 and status = 'accepted'`, [d.decision_key]);
    await tx.query(`update cm.decisions set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1::uuid`, [input.decisionId, input.acceptedBy]);
    await tx.query(`update cm.findings set status = 'corrected' where correction_decision_id = $1::uuid and status = 'open'`, [input.decisionId]);
  });
}

/**
 * Marks a finding verified if its verifying run completed and that run pinned the correction.
 * Decided in one statement against the stored rows, so a failed or unpinned run can never verify it.
 * Also the call to make after a verifying run that needed founder approval is resumed.
 */
export async function settleVerification(db: Db, findingId: string): Promise<boolean> {
  const rows = await db.withRole('evaluator_service', (tx) => tx.query(
    `update cm.findings f set status = 'verified'
     where f.id = $1::uuid and f.status = 'corrected'
       and exists (
         select 1 from cm.runs r join cm.run_decisions rd on rd.run_id = r.id
         where r.id = f.verifying_run_id and r.status = 'completed' and rd.decision_id = f.correction_decision_id
       )
     returning f.id`,
    [findingId],
  ));
  return rows.length > 0;
}

export interface VerifyResult { finding_id: string; verified: boolean; verifying_run_id: string; report: RunReport; }

/**
 * Starts a brand-new run: no parent, no repair notes on its first attempt, nothing from the conversation
 * that produced the correction. All the handler knows is the task and whatever accepted memory pins.
 */
export async function verifyFresh(db: Db, input: { findingId: string; profile: Profile; task: string; binding: AgentBinding }): Promise<VerifyResult> {
  const [f] = await db.withRole('evaluator_service', (tx) => tx.query<{ status: string; correction_status: string | null }>(
    `select f.status, d.status as correction_status from cm.findings f left join cm.decisions d on d.id = f.correction_decision_id where f.id = $1::uuid`,
    [input.findingId],
  ));
  if (!f) throw new Error(`FINDING_NOT_FOUND: ${input.findingId}`);
  if (f.status !== 'corrected' || f.correction_status !== 'accepted') {
    throw new Error(`CORRECTION_NOT_ACCEPTED: finding is ${f.status}, correction is ${f.correction_status ?? 'absent'}`);
  }

  const report = await runAgent(db, {
    profile: input.profile,
    task: input.task,
    binding: input.binding,
    memoryMode: 'on',
    onRunCreated: async (runId) => {
      await db.withRole('evaluator_service', (tx) => tx.query(`update cm.findings set verifying_run_id = $2::uuid where id = $1::uuid`, [input.findingId, runId]));
    },
  });
  return { finding_id: input.findingId, verified: await settleVerification(db, input.findingId), verifying_run_id: report.run_id, report };
}
