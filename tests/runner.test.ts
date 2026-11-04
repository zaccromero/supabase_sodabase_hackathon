import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/contract/hash';
import type { CheckSpec, DbRole, Evaluator, Handler, PinnedDecision } from '../src/contract/types';
import { pinnedFor, retrieveAccepted } from '../src/memory/index';
import {
  acceptDecision, approve, contractHash, correct, pgliteDb, recordFinding, resumeRun, runAgent, settleVerification, verifyFresh,
  type AgentBinding, type Db,
} from '../src/runner/index';

// All strings below are test fixtures, confined to throwaway in-memory databases.
const sql = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
const V1 = 'test fixture: statement v1';
const V2 = 'test fixture: statement v2';
const TASK = 'test fixture: task';

let raw: PGlite;
let db: Db;
let v1: string;
const rows = async <T = any>(q: string, p: unknown[] = []) => (await raw.query<T>(q, p)).rows;

async function addDecision(key: string, statement: string, scope: string[], status: 'accepted' | 'proposed') {
  const [source] = await rows<{ id: string }>(`insert into cm.sources (kind, uri, title) values ('owner_note','test:fixture','fixture') returning id`);
  const [d] = await rows<{ id: string }>(
    `insert into cm.decisions (decision_key, statement, scope, status, source_id, proposed_by, accepted_by, accepted_at)
     values ($1,$2,$3,$4,$5,'test',$6,$7) returning id`,
    [key, statement, scope, status, source!.id, status === 'accepted' ? 'test' : null, status === 'accepted' ? new Date() : null],
  );
  return d!.id;
}

const CHECK: CheckSpec = { check_id: 'states_memory', kind: 'deterministic', required: true, requires_evidence: true, spec: {} };

/** Passes only when the output states a statement the evaluator holds, so it reacts to what was really pinned. */
const statesMemory: Evaluator = async ({ check, output, decisions }) => {
  const held = decisions.map((d) => d.statement);
  const ok = held.includes(output.claim as string);
  return {
    check_id: check.check_id, verdict: ok ? 'pass' : 'fail', reason: ok ? 'matches memory' : `claim is not one of: ${held.join(' | ')}`,
    evaluator: 'test.states_memory', evaluator_version: '1', evidence: { kind: 'test_comparison', payload: { claim: output.claim, held } },
  };
};

/** Says what its memory says, or a wrong claim when it has nothing to go on. */
const faithful: Handler = async ({ decisions }) => ({ body: { claim: decisions[0]?.statement ?? 'wrong' }, evidence: [] });

const binding = (handler: Handler, evaluators: AgentBinding['evaluators'] = statesMemory, checks: AgentBinding['checks'] = [CHECK]): AgentBinding => ({ handler, evaluators, checks });
const recorded = (fn: Handler) => {
  const calls: Parameters<Handler>[0][] = [];
  const handler: Handler = async (input) => { calls.push(input); return fn(input); };
  return { calls, handler };
};

const runRow = async (id: string) => (await rows<any>(`select * from cm.runs where id = $1`, [id]))[0];
const verdicts = async (id: string) => (await rows<{ verdict: string }>(`select verdict from cm.gate_decisions where run_id = $1 order by created_at, id`, [id])).map((r) => r.verdict);
const ids = (pinned: PinnedDecision[]) => pinned.map((d) => d.id);

beforeEach(async () => {
  raw = new PGlite();
  await raw.exec(sql);
  db = pgliteDb(raw);
  v1 = await addDecision('test.key', V1, ['gym_operator'], 'accepted');
});

describe('db interface', () => {
  it('withRole is a real role switch that ends with the transaction', async () => {
    const [inside] = await db.withRole('agent_worker', (tx) => tx.query<{ u: string }>('select current_user as u'));
    expect(inside!.u).toBe('agent_worker');
    expect((await rows<{ u: string }>('select current_user as u'))[0]!.u).toBe('postgres');
    await expect(db.withRole('agent_worker', (tx) => tx.query(`update cm.runs set status = 'completed'`))).rejects.toThrow(/permission denied/);
    expect((await rows<{ u: string }>('select current_user as u'))[0]!.u).toBe('postgres');
    await expect(db.withRole('postgres; drop schema cm' as DbRole, async () => 1)).rejects.toThrow(/UNKNOWN_ROLE/);
  });
});

describe('memory', () => {
  it('retrieves accepted decisions in scope only', async () => {
    await addDecision('test.other_profile', 'x', ['milo_pitch'], 'accepted');
    await addDecision('test.not_accepted', 'y', ['gym_operator'], 'proposed');
    const got = await retrieveAccepted(db, 'gym_operator');
    expect(got.map((d) => d.decision_key)).toEqual(['test.key']);
    expect(got[0]).toMatchObject({ version: 1, statement: V1, source_uri: 'test:fixture', source_historical: false });
    expect((await retrieveAccepted(db, 'drift_reviewer')).map((d) => d.decision_key)).toEqual(['test.key', 'test.other_profile']);
  });

  it('a proposed decision is not pinned', async () => {
    const proposed = await addDecision('test.proposed', 'not yet', ['gym_operator'], 'proposed');
    const { calls, handler } = recorded(faithful);
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(handler) });
    expect(ids(report.pinned)).toEqual([v1]);
    expect(calls[0]!.decisions.map((d) => d.id)).not.toContain(proposed);
    expect(await rows(`select 1 from cm.run_decisions where decision_id = $1`, [proposed])).toEqual([]);
  });

  it('baseline pins nothing, is labeled, and is judged by the memory it was denied', async () => {
    const { calls, handler } = recorded(faithful);
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, memoryMode: 'baseline', repairBudget: 0, binding: binding(handler) });
    expect(calls[0]!.decisions).toEqual([]);
    expect(report).toMatchObject({ memory_mode: 'baseline', pinned: [], status: 'failed' });
    expect(report.attempts[0]!.evaluations[0]).toMatchObject({ verdict: 'fail' });
    expect((await runRow(report.run_id)).memory_mode).toBe('baseline');
    expect(await pinnedFor(db, report.run_id)).toEqual([]);
  });
});

describe('run loop', () => {
  it('blocked, then repaired, then completed', async () => {
    const { calls, handler } = recorded(async ({ repairNotes, decisions }) => ({
      body: { claim: repairNotes ? decisions[0]!.statement : 'wrong' },
      evidence: [{ kind: 'test_trace', payload: { step: 1 } }],
    }));
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(handler) });

    expect(report.status).toBe('completed');
    expect(report.attempts.map((a) => [a.attempt_no, a.kind, a.gate.verdict])).toEqual([[1, 'initial', 'blocked'], [2, 'repair', 'completed']]);
    expect(report.attempts[0]!.gate.missing[0]).toMatchObject({ check_id: 'states_memory', reason: 'FAILED' });
    expect(await verdicts(report.run_id)).toEqual(['blocked', 'completed']);

    // The repair attempt was told why, in the evaluator's words, and got the same pins.
    expect(calls[0]!.repairNotes).toBeUndefined();
    expect(calls[1]!.repairNotes!.join()).toContain('FAILED: claim is not one of');
    expect(calls[1]!.decisions.map((d) => d.id)).toEqual([v1]);

    const run = await runRow(report.run_id);
    expect(run.status).toBe('completed');
    expect(run.completed_at).not.toBeNull();

    // Hashes in the database match the canonical hash of what is stored, and the fail stays on record.
    const [contract] = await rows<any>(`select * from cm.check_contracts where run_id = $1`, [report.run_id]);
    const storedChecks = await rows<any>(`select * from cm.contract_checks where contract_id = $1`, [contract.id]);
    expect(contract.contract_sha256).toBe(contractHash(storedChecks));
    expect(contract.frozen_at).not.toBeNull();
    const outputs = await rows<any>(`select o.* from cm.outputs o join cm.attempts a on a.id = o.attempt_id where a.run_id = $1 order by a.attempt_no`, [report.run_id]);
    expect(outputs.map((o) => o.output_sha256)).toEqual(outputs.map((o) => sha256(o.body)));
    const evals = await rows<any>(`select verdict, evidence_id from cm.evaluations where run_id = $1 order by created_at, id`, [report.run_id]);
    expect(evals.map((e) => e.verdict)).toEqual(['fail', 'pass']);
    expect(evals.every((e) => e.evidence_id)).toBe(true);
    const evidenceBy = await rows<any>(`select created_by from cm.evidence where output_id = $1 order by created_by`, [outputs[1].id]);
    expect(evidenceBy.map((e) => e.created_by)).toEqual(['agent_worker', 'test.states_memory']);
  });

  it('writes each stage under its own role', async () => {
    const seen: DbRole[] = [];
    const spy: Db = { ...db, withRole: (role, fn) => { seen.push(role); return db.withRole(role, fn); } };
    await runAgent(spy, { profile: 'gym_operator', task: TASK, binding: binding(faithful) });
    expect(seen).toContain('agent_worker');
    expect(seen.indexOf('agent_worker')).toBeLessThan(seen.indexOf('evaluator_service'));
    expect(seen.lastIndexOf('evaluator_service')).toBeLessThan(seen.lastIndexOf('gate_service'));
    expect(seen).not.toContain('founder_approver');
  });

  it('budget exhaustion stays failed, and the database is what refused', async () => {
    const { calls, handler } = recorded(async () => ({ body: { claim: 'always wrong' }, evidence: [] }));
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(handler) });

    expect(report).toMatchObject({ status: 'failed', failure_reason: 'REPAIR_BUDGET_EXHAUSTED' });
    expect(calls).toHaveLength(3);
    expect(report.attempts.map((a) => a.kind)).toEqual(['initial', 'repair', 'repair']);
    expect(await verdicts(report.run_id)).toEqual(['blocked', 'blocked', 'blocked']);
    const run = await runRow(report.run_id);
    expect(run.status).toBe('failed');
    expect(run.completed_at).toBeNull();
    const [contract] = await rows<any>(`select id from cm.check_contracts where run_id = $1`, [report.run_id]);
    await expect(rows(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,4,'repair')`, [report.run_id, contract.id])).rejects.toThrow(/REPAIR_BUDGET_EXHAUSTED/);
  });

  it('a handler crash writes nothing, is blocked by the gate, and can be repaired', async () => {
    let n = 0;
    const { calls, handler } = recorded(async (input) => { if (++n === 1) throw new Error('boom'); return faithful(input); });
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(handler) });
    expect(report.status).toBe('completed');
    expect(report.attempts[0]).toMatchObject({ handler_error: 'boom' });
    expect(report.attempts[0]!.gate.missing[0]!.reason).toBe('NO_OUTPUT');
    expect(calls[1]!.repairNotes).toContain('handler_error: boom');
  });

  it('an evaluator crash or a pass without evidence never counts as a pass', async () => {
    const crash: Evaluator = async () => { throw new Error('evaluator down'); };
    const crashed = await runAgent(db, { profile: 'gym_operator', task: TASK, repairBudget: 0, binding: binding(faithful, crash) });
    expect(crashed.status).toBe('failed');
    expect(crashed.attempts[0]!.gate.missing[0]!.reason).toBe('NO_CURRENT_EVALUATION');
    expect(crashed.attempts[0]!.evaluator_errors[0]!.error).toBe('evaluator down');

    const noEvidence: Evaluator = async ({ check }) => ({ check_id: check.check_id, verdict: 'pass', reason: 'trust me', evaluator: 't', evaluator_version: '1' });
    const unproven = await runAgent(db, { profile: 'gym_operator', task: TASK, repairBudget: 0, binding: binding(faithful, noEvidence) });
    expect(unproven.status).toBe('failed');
    expect(unproven.attempts[0]!.gate.missing[0]!.reason).toBe('NO_CURRENT_EVIDENCE');

    const wrongCheck: Evaluator = async () => ({ check_id: 'some_other_check', verdict: 'pass', reason: 'x', evaluator: 't', evaluator_version: '1', evidence: { kind: 'k', payload: {} } });
    const misdirected = await runAgent(db, { profile: 'gym_operator', task: TASK, repairBudget: 0, binding: binding(faithful, wrongCheck) });
    expect(misdirected.status).toBe('failed');
    expect(misdirected.attempts[0]!.evaluator_errors[0]!.error).toMatch(/EVALUATOR_CHECK_MISMATCH/);
  });

  it('refuses a contract with nothing required, or one bound to a decision the run does not hold', async () => {
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(faithful, statesMemory, [{ ...CHECK, required: false }]) });
    expect(report).toMatchObject({ status: 'failed', failure_reason: 'NO_REQUIRED_CHECKS', attempts: [] });
    expect((await runRow(report.run_id)).status).toBe('failed');
    expect(await verdicts(report.run_id)).toEqual(['blocked']);

    const other = await addDecision('test.other', 'z', ['milo_pitch'], 'accepted');
    const stale = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(faithful, statesMemory, [{ ...CHECK, decision_id: other }]) });
    expect(stale.failure_reason).toMatch(/CHECK_DECISION_NOT_IN_MEMORY/);
  });

  it('checks can be built from the decisions the run pinned', async () => {
    const report = await runAgent(db, {
      profile: 'gym_operator', task: TASK,
      binding: binding(faithful, statesMemory, (decisions) => decisions.map((d) => ({ ...CHECK, decision_id: d.id }))),
    });
    expect(report.status).toBe('completed');
    expect((await rows<any>(`select decision_id from cm.contract_checks where contract_id = $1`, [report.contract_id]))[0].decision_id).toBe(v1);
  });

  it('rejects an evaluators map with no entry for a check, without passing it', async () => {
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, repairBudget: 0, binding: binding(faithful, {}) });
    expect(report.status).toBe('failed');
    expect(report.attempts[0]!.evaluator_errors[0]!.error).toMatch(/NO_EVALUATOR_FOR_CHECK/);
  });
});

describe('founder approval', () => {
  const unsure: Evaluator = async ({ check }) => ({
    check_id: check.check_id, verdict: 'uncertain', reason: 'needs a human', evaluator: 'test.critic', evaluator_version: '1', evidence: { kind: 'test_note', payload: {} },
  });

  it('uncertain waits for the founder, and approval completes on the next gate call', async () => {
    const b = binding(faithful, unsure);
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: b });
    expect(report.status).toBe('awaiting_approval');
    expect((await runRow(report.run_id)).status).toBe('awaiting_approval');

    await expect(resumeRun(db, { runId: report.run_id, binding: b })).resolves.toMatchObject({ status: 'awaiting_approval', attempts: [] });
    await approve(db, { evaluationId: report.attempts[0]!.evaluations[0]!.evaluation_id, decision: 'approved', approver: 'test-founder' });
    await expect(resumeRun(db, { runId: report.run_id, binding: b })).resolves.toMatchObject({ status: 'completed', attempts: [] });
    expect((await runRow(report.run_id)).status).toBe('completed');
    await expect(resumeRun(db, { runId: report.run_id, binding: b })).rejects.toThrow(/RUN_NOT_RESUMABLE/);
  });

  it('a founder rejection sends the run to repair, with the reason in the notes', async () => {
    let n = 0;
    const critic: Evaluator = async (input) => (++n === 1 ? unsure(input) : statesMemory(input));
    const { calls, handler } = recorded(faithful);
    const b = binding(handler, critic);
    const report = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: b });
    await approve(db, { evaluationId: report.attempts[0]!.evaluations[0]!.evaluation_id, decision: 'rejected', approver: 'test-founder', note: 'too vague' });
    const resumed = await resumeRun(db, { runId: report.run_id, binding: b });
    expect(resumed.status).toBe('completed');
    expect(resumed.attempts.map((a) => a.kind)).toEqual(['repair']);
    expect(calls[1]!.repairNotes!.join()).toContain('Founder rejected this: too vague');
  });
});

describe('correction survives a fresh run', () => {
  async function findingOnFirstRun() {
    const first = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(faithful) });
    const findingId = await recordFinding(db, {
      targetOutputId: first.attempts[0]!.output_id!, decisionId: v1, excerpt: V1, explanation: 'fixture: v1 is out of date', proposedRepair: V2,
    });
    return { first, findingId };
  }
  const finding = async (id: string) => (await rows<any>(`select * from cm.findings where id = $1`, [id]))[0];

  it('a correction accepted once is pinned by every brand-new run', async () => {
    const { first, findingId } = await findingOnFirstRun();
    const { decisionId, version } = await correct(db, { findingId, proposedBy: 'test.reviewer' });
    expect(version).toBe(2);
    expect(await finding(findingId)).toMatchObject({ status: 'open', correction_decision_id: decisionId });

    // Proposed is not memory: a run started now still pins v1, and verification is refused.
    const beforeAccept = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(faithful) });
    expect(ids(beforeAccept.pinned)).toEqual([v1]);
    await expect(verifyFresh(db, { findingId, profile: 'gym_operator', task: TASK, binding: binding(faithful) })).rejects.toThrow(/CORRECTION_NOT_ACCEPTED/);
    expect((await finding(findingId)).verifying_run_id).toBeNull();

    await acceptDecision(db, { decisionId, acceptedBy: 'test-founder' });
    expect((await rows<any>(`select status from cm.decisions where id = $1`, [v1]))[0].status).toBe('superseded');
    expect((await finding(findingId)).status).toBe('corrected');

    const { calls, handler } = recorded(faithful);
    const result = await verifyFresh(db, { findingId, profile: 'gym_operator', task: TASK, binding: binding(handler) });
    expect(result.verified).toBe(true);
    expect(ids(result.report.pinned)).toEqual([decisionId]);

    // Fresh means fresh: no parent, no notes, one attempt, and the only knowledge is the task and the pin.
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!).sort()).toEqual(['attemptNo', 'decisions', 'runId', 'task']);
    expect(calls[0]!.decisions[0]).toMatchObject({ statement: V2, version: 2 });
    expect((await runRow(result.verifying_run_id)).parent_run_id).toBeNull();
    expect(await finding(findingId)).toMatchObject({ status: 'verified', verifying_run_id: result.verifying_run_id });

    // Nothing further needed for the next new run, and the old runs keep the version they pinned.
    const later = await runAgent(db, { profile: 'gym_operator', task: TASK, binding: binding(faithful) });
    expect(later.status).toBe('completed');
    expect(ids(later.pinned)).toEqual([decisionId]);
    expect(ids(await pinnedFor(db, first.run_id))).toEqual([v1]);
  });

  it('a verifying run that does not complete leaves the finding unverified, with the run on record', async () => {
    const { findingId } = await findingOnFirstRun();
    const { decisionId } = await correct(db, { findingId, proposedBy: 'test.reviewer' });
    await acceptDecision(db, { decisionId, acceptedBy: 'test-founder' });
    const stubborn = binding(async () => ({ body: { claim: V1 }, evidence: [] }));
    const result = await verifyFresh(db, { findingId, profile: 'gym_operator', task: TASK, binding: stubborn });
    expect(result.verified).toBe(false);
    expect(result.report.status).toBe('failed');
    expect(await finding(findingId)).toMatchObject({ status: 'corrected', verifying_run_id: result.verifying_run_id });
  });

  it('a completed verifying run that did not pin the correction does not verify the finding', async () => {
    const { findingId } = await findingOnFirstRun();
    const { decisionId } = await correct(db, { findingId, proposedBy: 'test.reviewer' });
    await acceptDecision(db, { decisionId, acceptedBy: 'test-founder' });
    // The decision is scoped to gym_operator, so a milo_pitch run cannot pin it.
    await addDecision('test.milo', 'milo fixture', ['milo_pitch'], 'accepted');
    const result = await verifyFresh(db, { findingId, profile: 'milo_pitch', task: TASK, binding: binding(faithful) });
    expect(result.report.status).toBe('completed');
    expect(result.verified).toBe(false);
    expect((await finding(findingId)).status).toBe('corrected');
  });

  it('only the founder role accepts, and a second correction on the same finding is refused', async () => {
    const { findingId } = await findingOnFirstRun();
    const { decisionId } = await correct(db, { findingId, proposedBy: 'test.reviewer' });
    await expect(correct(db, { findingId, proposedBy: 'test.reviewer' })).rejects.toThrow(/CORRECTION_ALREADY_PROPOSED/);
    await expect(db.withRole('gate_service', (tx) => tx.query(`update cm.decisions set status = 'accepted', accepted_by = 'x', accepted_at = now() where id = $1`, [decisionId]))).rejects.toThrow(/permission denied/);
    await acceptDecision(db, { decisionId, acceptedBy: 'test-founder' });
    await expect(acceptDecision(db, { decisionId, acceptedBy: 'test-founder' })).rejects.toThrow(/DECISION_NOT_PROPOSED/);
  });

  it('settleVerification is safe to call early and picks up a resumed run', async () => {
    const { findingId } = await findingOnFirstRun();
    expect(await settleVerification(db, findingId)).toBe(false);
    const { decisionId } = await correct(db, { findingId, proposedBy: 'test.reviewer' });
    await acceptDecision(db, { decisionId, acceptedBy: 'test-founder' });
    const unsure: Evaluator = async ({ check }) => ({ check_id: check.check_id, verdict: 'uncertain', reason: 'r', evaluator: 'c', evaluator_version: '1', evidence: { kind: 'k', payload: {} } });
    const b = binding(faithful, unsure);
    const result = await verifyFresh(db, { findingId, profile: 'gym_operator', task: TASK, binding: b });
    expect(result).toMatchObject({ verified: false, report: { status: 'awaiting_approval' } });
    await approve(db, { evaluationId: result.report.attempts[0]!.evaluations[0]!.evaluation_id, decision: 'approved', approver: 'test-founder' });
    await resumeRun(db, { runId: result.verifying_run_id, binding: b });
    expect(await settleVerification(db, findingId)).toBe(true);
  });
});
