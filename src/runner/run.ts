// The run loop from docs/CONTRACT.md. The database decides every outcome; this file only asks it.
import { sha256 } from '../contract/hash';
import type {
  CheckSpec, EvaluationBinding, EvaluationResult, Evaluator, GateResult, Handler, PinnedDecision, Profile, Verdict,
} from '../contract/types';
import { pinAccepted, pinnedFor, retrieveAccepted } from '../memory/index';
import type { Db } from './db';

export type MemoryMode = 'on' | 'baseline';
export type ChecksSource = CheckSpec[] | ((decisions: PinnedDecision[]) => CheckSpec[] | Promise<CheckSpec[]>);

/** What lanes 3 and 4 inject. evaluators is one dispatching Evaluator or a map keyed by check_id. */
export interface AgentBinding {
  handler: Handler;
  evaluators: Evaluator | Record<string, Evaluator>;
  checks: ChecksSource;
}

export interface RunOptions {
  profile: Profile;
  task: string;
  binding: AgentBinding;
  /** baseline pins nothing and gives the handler no memory. Default 'on'. */
  memoryMode?: MemoryMode;
  parentRunId?: string;
  techniqueId?: string;
  /** Column default (2) applies when omitted. The database enforces whatever is set. */
  repairBudget?: number;
  /** Called once the run row exists, before any attempt. */
  onRunCreated?: (runId: string) => Promise<void>;
}

export type RunStatus = 'completed' | 'blocked' | 'awaiting_approval' | 'failed';

export interface EvaluationReport { evaluation_id: string; check_id: string; verdict: Verdict; reason: string; }

export interface AttemptReport {
  attempt_id: string;
  attempt_no: number;
  kind: 'initial' | 'repair';
  output_id?: string;
  output_sha256?: string;
  handler_error?: string;
  evaluator_errors: Array<{ check_id: string; error: string }>;
  evaluations: EvaluationReport[];
  repair_notes?: string[];
  gate: GateResult;
}

export interface RunReport {
  run_id: string;
  contract_id?: string;
  contract_sha256?: string;
  profile: Profile;
  task: string;
  memory_mode: MemoryMode;
  status: RunStatus;
  pinned: PinnedDecision[];
  /** Attempts executed by this call. resumeRun reports only the attempts it ran. */
  attempts: AttemptReport[];
  /** Latest gate verdict, including one reached without a new attempt. */
  gate?: GateResult;
  failure_reason?: string;
}

/** Sorted and with every column spelled out, so the hash can be recomputed from cm.contract_checks. */
export function contractHash(checks: CheckSpec[]): string {
  const normalized = checks
    .map((c) => ({
      check_id: c.check_id, kind: c.kind, required: c.required, requires_evidence: c.requires_evidence,
      decision_id: c.decision_id ?? null, spec: c.spec,
    }))
    .sort((a, b) => (a.check_id < b.check_id ? -1 : a.check_id > b.check_id ? 1 : 0));
  return sha256(normalized);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Everything one drive of the loop needs, whether it started now or is resuming. */
interface LiveRun {
  db: Db;
  binding: AgentBinding;
  runId: string;
  contractId: string;
  contractSha: string;
  checks: CheckSpec[];
  /** What the handler may see: the pins, or nothing on a baseline run. */
  handlerDecisions: PinnedDecision[];
  /** What evaluators judge against. A baseline run is judged by the same memory its handler was denied. */
  evaluatorDecisions: PinnedDecision[];
  task: string;
  technique?: Record<string, unknown>;
}

async function setStatus(db: Db, runId: string, status: 'running' | 'failed') {
  await db.withRole('gate_service', (tx) => tx.query(`update cm.runs set status = $2 where id = $1::uuid`, [runId, status]));
}

export async function requestCompletion(db: Db, runId: string): Promise<GateResult> {
  const [row] = await db.withRole('gate_service', (tx) => tx.query<{ r: GateResult }>(`select cm.request_completion($1::uuid) as r`, [runId]));
  return row!.r;
}

async function createAttempt(db: Db, run: LiveRun, kind: 'initial' | 'repair') {
  return db.withRole('gate_service', async (tx) => {
    const [row] = await tx.query<{ id: string; attempt_no: number }>(
      `insert into cm.attempts (run_id, contract_id, attempt_no, kind)
       select $1::uuid, $2::uuid, coalesce(max(attempt_no), 0) + 1, $3 from cm.attempts where run_id = $1::uuid
       returning id, attempt_no`,
      [run.runId, run.contractId, kind],
    );
    await tx.query(`update cm.runs set status = 'running' where id = $1::uuid`, [run.runId]);
    return { id: row!.id, attempt_no: row!.attempt_no, kind };
  });
}

/** Handler result goes in as agent_worker. Returns the body as stored, so evaluators judge exactly what the hash covers. */
async function writeOutput(run: LiveRun, attemptId: string, result: Awaited<ReturnType<Handler>>) {
  const body = JSON.parse(JSON.stringify(result.body)) as Record<string, unknown>;
  const hash = sha256(body);
  return run.db.withRole('agent_worker', async (tx) => {
    const [output] = await tx.query<{ id: string; body: Record<string, unknown> }>(
      `insert into cm.outputs (attempt_id, body, output_sha256) values ($1::uuid, $2::jsonb, $3) returning id, body`,
      [attemptId, JSON.stringify(body), hash],
    );
    for (const e of result.evidence) {
      await tx.query(
        `insert into cm.evidence (output_id, kind, uri, sha256, payload, created_by) values ($1::uuid, $2, $3, $4, $5::jsonb, 'agent_worker')`,
        [output!.id, e.kind, e.uri ?? null, e.sha256 ?? null, JSON.stringify(e.payload ?? {})],
      );
    }
    return { id: output!.id, body: output!.body, sha: hash };
  });
}

/** Evidence then evaluation, as evaluator_service, in one transaction. The database rejects a bad binding. */
async function writeEvaluation(run: LiveRun, binding: EvaluationBinding, result: EvaluationResult): Promise<EvaluationReport> {
  return run.db.withRole('evaluator_service', async (tx) => {
    let evidenceId: string | null = null;
    if (result.evidence) {
      const [row] = await tx.query<{ id: string }>(
        `insert into cm.evidence (output_id, kind, uri, sha256, payload, created_by) values ($1::uuid, $2, $3, $4, $5::jsonb, $6) returning id`,
        [binding.output_id, result.evidence.kind, result.evidence.uri ?? null, result.evidence.sha256 ?? null, JSON.stringify(result.evidence.payload ?? {}), result.evaluator],
      );
      evidenceId = row!.id;
    }
    const [row] = await tx.query<{ id: string }>(
      `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12::uuid) returning id`,
      [binding.run_id, binding.attempt_id, binding.output_id, binding.contract_id, result.check_id, binding.output_sha256, binding.contract_sha256, result.evaluator, result.evaluator_version, result.verdict, result.reason, evidenceId],
    );
    return { evaluation_id: row!.id, check_id: result.check_id, verdict: result.verdict, reason: result.reason };
  });
}

function evaluatorFor(binding: AgentBinding, check: CheckSpec): Evaluator {
  if (typeof binding.evaluators === 'function') return binding.evaluators;
  const evaluator = binding.evaluators[check.check_id];
  if (!evaluator) throw new Error(`NO_EVALUATOR_FOR_CHECK: ${check.check_id}`);
  return evaluator;
}

/**
 * One attempt: handler, then every check on the stored output. A crash writes no result, so the gate
 * reports the gap (NO_OUTPUT, NO_CURRENT_EVALUATION) and no pass is ever invented on its behalf.
 */
async function executeAttempt(run: LiveRun, attempt: { id: string; attempt_no: number; kind: 'initial' | 'repair' }, repairNotes?: string[]): Promise<AttemptReport> {
  const report: AttemptReport = {
    attempt_id: attempt.id, attempt_no: attempt.attempt_no, kind: attempt.kind,
    evaluator_errors: [], evaluations: [], gate: { run_id: run.runId, verdict: 'blocked', missing: [] },
    ...(repairNotes ? { repair_notes: repairNotes } : {}),
  };

  let output: { id: string; body: Record<string, unknown>; sha: string };
  try {
    const result = await run.binding.handler({
      runId: run.runId, attemptNo: attempt.attempt_no, task: run.task, decisions: run.handlerDecisions,
      ...(repairNotes ? { repairNotes } : {}),
      ...(run.technique ? { technique: run.technique } : {}),
    });
    output = await writeOutput(run, attempt.id, result);
  } catch (err) {
    report.handler_error = message(err);
    return report;
  }
  report.output_id = output.id;
  report.output_sha256 = output.sha;

  const binding: EvaluationBinding = {
    run_id: run.runId, attempt_id: attempt.id, output_id: output.id, contract_id: run.contractId,
    output_sha256: output.sha, contract_sha256: run.contractSha,
  };
  const settled = await Promise.allSettled(run.checks.map(async (check) => {
    const result = await evaluatorFor(run.binding, check)({ binding, check, output: output.body, decisions: run.evaluatorDecisions });
    if (result.check_id !== check.check_id) throw new Error(`EVALUATOR_CHECK_MISMATCH: asked for ${check.check_id}, got ${result.check_id}`);
    return result;
  }));
  for (const [i, outcome] of settled.entries()) {
    const check_id = run.checks[i]!.check_id;
    if (outcome.status === 'rejected') { report.evaluator_errors.push({ check_id, error: message(outcome.reason) }); continue; }
    try {
      report.evaluations.push(await writeEvaluation(run, binding, outcome.value));
    } catch (err) {
      report.evaluator_errors.push({ check_id, error: message(err) });
    }
  }
  return report;
}

/** What the repair attempt is told: why each check is open, in the evaluator's and founder's own words. */
async function repairNotesFor(db: Db, gate: GateResult, last?: AttemptReport): Promise<string[]> {
  const ids = gate.missing.flatMap((m) => (m.evaluation_id ? [m.evaluation_id] : []));
  const rows = ids.length === 0 ? [] : await db.withRole('gate_service', (tx) => tx.query<{ id: string; reason: string; approval: string | null; approval_note: string | null }>(
    `select e.id, e.reason, a.decision as approval, a.note as approval_note
     from cm.evaluations e left join cm.approvals a on a.evaluation_id = e.id
     where e.id::text = any($1::text[])`,
    [ids],
  ));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const notes = gate.missing.map((m) => {
    const row = m.evaluation_id ? byId.get(m.evaluation_id) : undefined;
    const founder = row?.approval === 'rejected' ? ` Founder rejected this${row.approval_note ? `: ${row.approval_note}` : '.'}` : '';
    return `${m.check_id ?? 'run'}: ${m.reason}${row ? `: ${row.reason}` : ''}${founder}`;
  });
  if (last?.handler_error) notes.push(`handler_error: ${last.handler_error}`);
  for (const e of last?.evaluator_errors ?? []) notes.push(`evaluator_error ${e.check_id}: ${e.error}`);
  return notes;
}

/** A founder rejection leaves the gate at NEEDS_FOUNDER_APPROVAL, and only a new attempt can answer it. */
async function hasRejection(db: Db, gate: GateResult): Promise<boolean> {
  const ids = gate.missing.flatMap((m) => (m.evaluation_id ? [m.evaluation_id] : []));
  if (ids.length === 0) return false;
  const rows = await db.withRole('gate_service', (tx) => tx.query(
    `select 1 from cm.approvals where decision = 'rejected' and evaluation_id::text = any($1::text[]) limit 1`, [ids],
  ));
  return rows.length > 0;
}

/**
 * Starting from a gate verdict, keep repairing until the gate passes, the founder is needed,
 * or the database refuses another repair attempt. The budget lives in the database, not here.
 */
async function settle(run: LiveRun, report: RunReport, gateIn: GateResult, lastIn?: AttemptReport): Promise<RunReport> {
  let gate = gateIn;
  let last = lastIn;
  for (;;) {
    report.gate = gate;
    if (gate.verdict === 'completed') { report.status = 'completed'; return report; }
    if (gate.verdict === 'awaiting_approval' && !(await hasRejection(run.db, gate))) { report.status = 'awaiting_approval'; return report; }

    const notes = await repairNotesFor(run.db, gate, last);
    let attempt;
    try {
      attempt = await createAttempt(run.db, run, 'repair');
    } catch (err) {
      if (!/REPAIR_BUDGET_EXHAUSTED/.test(message(err))) throw err;
      await setStatus(run.db, run.runId, 'failed');
      report.status = 'failed';
      report.failure_reason = 'REPAIR_BUDGET_EXHAUSTED';
      return report;
    }
    last = await executeAttempt(run, attempt, notes);
    gate = last.gate = await requestCompletion(run.db, run.runId);
    report.attempts.push(last);
  }
}

/** An unexpected error must not leave a run looking alive. */
async function failingVisibly<T>(db: Db, runId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    await setStatus(db, runId, 'failed').catch(() => {});
    throw err;
  }
}

async function loadTechnique(db: Db, techniqueId?: string) {
  if (!techniqueId) return undefined;
  const [row] = await db.withRole('gate_service', (tx) => tx.query<{ extraction: Record<string, unknown> }>(
    `select extraction from cm.techniques where id = $1::uuid`, [techniqueId],
  ));
  if (!row) throw new Error(`TECHNIQUE_NOT_FOUND: ${techniqueId}`);
  return row.extraction;
}

/** Why a contract cannot be frozen. The gate treats a contract with no required check as vacuously complete. */
function contractProblem(checks: CheckSpec[], decisions: PinnedDecision[]): string | undefined {
  if (!checks.some((c) => c.required)) return 'NO_REQUIRED_CHECKS';
  const known = new Set(decisions.map((d) => d.id));
  const stale = checks.find((c) => c.decision_id && !known.has(c.decision_id));
  if (stale) return `CHECK_DECISION_NOT_IN_MEMORY: ${stale.check_id} names a decision this run does not hold`;
  return undefined;
}

/** Create run, pin, freeze the contract, then attempt and repair until an outcome. */
export async function runAgent(db: Db, opts: RunOptions): Promise<RunReport> {
  const memoryMode = opts.memoryMode ?? 'on';
  const technique = await loadTechnique(db, opts.techniqueId);

  const runId = await db.withRole('gate_service', async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into cm.runs (profile, task, status, memory_mode, parent_run_id, technique_id, repair_budget)
       values ($1, $2, 'pending', $3, $4::uuid, $5::uuid, coalesce($6::int, 2)) returning id`,
      [opts.profile, opts.task, memoryMode, opts.parentRunId ?? null, opts.techniqueId ?? null, opts.repairBudget ?? null],
    );
    if (memoryMode === 'on') await pinAccepted(tx, row!.id, opts.profile);
    return row!.id;
  });

  return failingVisibly(db, runId, async () => {
    await opts.onRunCreated?.(runId);
    const pinned = await pinnedFor(db, runId);
    const evaluatorDecisions = memoryMode === 'on' ? pinned : await retrieveAccepted(db, opts.profile);
    const report: RunReport = { run_id: runId, profile: opts.profile, task: opts.task, memory_mode: memoryMode, status: 'blocked', pinned, attempts: [] };

    const checks = typeof opts.binding.checks === 'function' ? await opts.binding.checks(evaluatorDecisions) : opts.binding.checks;
    const problem = contractProblem(checks, evaluatorDecisions);
    if (problem) {
      // The gate records CONTRACT_NOT_FROZEN, then the run stops visibly.
      report.gate = await requestCompletion(db, runId);
      await setStatus(db, runId, 'failed');
      report.status = 'failed';
      report.failure_reason = problem;
      return report;
    }

    const contractSha = contractHash(checks);
    const contractId = await db.withRole('gate_service', async (tx) => {
      const [row] = await tx.query<{ id: string }>(`insert into cm.check_contracts (run_id) values ($1::uuid) returning id`, [runId]);
      for (const c of checks) {
        await tx.query(
          `insert into cm.contract_checks (contract_id, check_id, kind, required, requires_evidence, decision_id, spec)
           values ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::jsonb)`,
          [row!.id, c.check_id, c.kind, c.required, c.requires_evidence, c.decision_id ?? null, JSON.stringify(c.spec)],
        );
      }
      await tx.query(`update cm.check_contracts set contract_sha256 = $2, frozen_at = now() where id = $1::uuid`, [row!.id, contractSha]);
      return row!.id;
    });
    report.contract_id = contractId;
    report.contract_sha256 = contractSha;

    const run: LiveRun = {
      db, binding: opts.binding, runId, contractId, contractSha, checks,
      handlerDecisions: memoryMode === 'on' ? pinned : [],
      evaluatorDecisions, task: opts.task, ...(technique ? { technique } : {}),
    };
    const attempt = await createAttempt(db, run, 'initial');
    const first = await executeAttempt(run, attempt);
    first.gate = await requestCompletion(db, runId);
    report.attempts.push(first);
    return settle(run, report, first.gate, first);
  });
}

/**
 * Founder answers an uncertain check. Runs as founder_approver.
 * Afterwards call resumeRun: approval completes the check, rejection triggers a repair attempt.
 */
export async function approve(db: Db, input: { evaluationId: string; decision: 'approved' | 'rejected'; approver: string; note?: string }): Promise<void> {
  await db.withRole('founder_approver', (tx) => tx.query(
    `insert into cm.approvals (evaluation_id, decision, approver, note) values ($1::uuid, $2, $3, $4)`,
    [input.evaluationId, input.decision, input.approver, input.note ?? null],
  ));
}

/** Calls the gate again for a run that stopped short of completion. Uses the original pins and frozen contract. */
export async function resumeRun(db: Db, input: { runId: string; binding: AgentBinding }): Promise<RunReport> {
  const { runId } = input;
  const [row] = await db.withRole('gate_service', (tx) => tx.query<{
    profile: Profile; task: string; status: string; memory_mode: MemoryMode; technique_id: string | null; contract_id: string | null; contract_sha256: string | null;
  }>(
    `select r.profile, r.task, r.status, r.memory_mode, r.technique_id, c.id as contract_id, c.contract_sha256
     from cm.runs r left join cm.check_contracts c on c.run_id = r.id where r.id = $1::uuid`,
    [runId],
  ));
  if (!row) throw new Error(`RUN_NOT_FOUND: ${runId}`);
  if (row.status !== 'awaiting_approval' && row.status !== 'blocked') throw new Error(`RUN_NOT_RESUMABLE: ${row.status}`);
  if (!row.contract_id || !row.contract_sha256) throw new Error('RUN_NOT_RESUMABLE: contract never froze');

  return failingVisibly(db, runId, async () => {
    const stored = await db.withRole('gate_service', (tx) => tx.query<{
      check_id: string; kind: CheckSpec['kind']; required: boolean; requires_evidence: boolean; decision_id: string | null; spec: Record<string, unknown>;
    }>(`select check_id, kind, required, requires_evidence, decision_id, spec from cm.contract_checks where contract_id = $1::uuid`, [row.contract_id]));
    const checks: CheckSpec[] = stored.map((c) => ({
      check_id: c.check_id, kind: c.kind, required: c.required, requires_evidence: c.requires_evidence, spec: c.spec,
      ...(c.decision_id ? { decision_id: c.decision_id } : {}),
    }));
    const pinned = await pinnedFor(db, runId);
    const technique = await loadTechnique(db, row.technique_id ?? undefined);
    const run: LiveRun = {
      db, binding: input.binding, runId, contractId: row.contract_id!, contractSha: row.contract_sha256!, checks,
      handlerDecisions: row.memory_mode === 'on' ? pinned : [],
      evaluatorDecisions: row.memory_mode === 'on' ? pinned : await retrieveAccepted(db, row.profile),
      task: row.task, ...(technique ? { technique } : {}),
    };
    const report: RunReport = {
      run_id: runId, contract_id: row.contract_id!, contract_sha256: row.contract_sha256!, profile: row.profile, task: row.task,
      memory_mode: row.memory_mode, status: 'blocked', pinned, attempts: [],
    };
    return settle(run, report, await requestCompletion(db, runId));
  });
}
