// Reads the shared records as dashboard_reader and assembles the finding chain.
// Nothing here invents a state: a link with no row behind it comes back null and
// the screen says that step has not happened.
import { withRole, type Tx } from './db';

export interface RunRow {
  run_id: string; profile: string; task: string; status: string; memory_mode: string;
  parent_run_id: string | null; created_at: Date; completed_at: Date | null;
  attempt_id: string | null; attempt_no: number | null; output_id: string | null;
  output_sha256: string | null; contract_id: string | null; contract_sha256: string | null;
  missing: Missing[]; technique_id: string | null;
}
export interface Missing { check_id?: string; reason: string; evaluation_id?: string }
export interface ChainRow {
  finding_id: string; status: string; decision_key: string; decision_version: number;
  decision_statement: string; decision_source: string; source_historical: boolean;
  excerpt: string; explanation: string; proposed_repair: string; target_output_id: string;
  correction_decision_id: string | null; verifying_run_id: string | null;
  verifying_run_status: string | null; created_at: Date;
}
export interface DecisionRow {
  id: string; decision_key: string; version: number; statement: string; scope: string[];
  status: string; source_id: string; supersedes_id: string | null; proposed_by: string;
  accepted_by: string | null; accepted_at: Date | null; implementation_state: string; created_at: Date;
}
export interface SourceRow {
  id: string; kind: string; uri: string; title: string; content_sha256: string | null;
  historical: boolean; captured_at: Date;
}
export interface EvaluationRow {
  id: string; run_id: string; attempt_id: string; output_id: string; check_id: string;
  output_sha256: string; contract_sha256: string; evaluator: string; evaluator_version: string;
  verdict: 'pass' | 'fail' | 'uncertain'; reason: string; evidence_id: string | null; created_at: Date;
}
export interface GateRow {
  id: string; run_id: string; attempt_id: string | null; verdict: string; missing: Missing[]; created_at: Date;
}
export interface QualityRow {
  id: string; provider: string; provider_finding_id: string | null; table_name: string; verdict: string;
  problem: string | null; finding_count: number | null; severity: string | null; observed_at: Date; disposition: string | null;
}
export interface AttemptRow {
  id: string; run_id: string; attempt_no: number; kind: string; created_at: Date;
  output_id: string | null; output_sha256: string | null; body: Record<string, unknown> | null;
}
export interface EvidenceRow {
  id: string; output_id: string; kind: string; uri: string | null; sha256: string | null; created_by: string; created_at: Date;
  historical_label: string | null; served_model: string | null;
}
export interface ApprovalRow { evaluation_id: string; decision: string; approver: string; created_at: Date }
export interface PinRow { run_id: string; decision_id: string }

export interface Records {
  readAt: Date;
  runs: RunRow[];
  chains: ChainRow[];
  decisions: DecisionRow[];
  sources: SourceRow[];
  evaluations: EvaluationRow[];
  gates: GateRow[];
  quality: QualityRow[];
  attempts: AttemptRow[];
  evidence: EvidenceRow[];
  approvals: ApprovalRow[];
  pins: PinRow[];
}

async function readAll(tx: Tx): Promise<Records> {
  const [{ now }] = await tx.query<{ now: Date }>(`select now() as now`);
  const runs = await tx.query<RunRow>(
    `select v.*, r.technique_id from cm.v_run_status v join cm.runs r on r.id = v.run_id
     order by v.created_at desc, v.run_id limit 200`);
  const chains = await tx.query<ChainRow>(`select * from cm.v_finding_chain order by created_at desc, finding_id limit 100`);
  const decisions = await tx.query<DecisionRow>(`select * from cm.decisions order by created_at desc, id limit 200`);
  const sources = await tx.query<SourceRow>(`select id, kind, uri, title, content_sha256, historical, captured_at from cm.sources`);
  const evaluations = await tx.query<EvaluationRow>(
    `select id, run_id, attempt_id, output_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id, created_at
     from cm.evaluations order by created_at desc, id desc limit 300`);
  const gates = await tx.query<GateRow>(`select * from cm.gate_decisions order by created_at desc, id limit 300`);
  const quality = await tx.query<QualityRow>(
    `select id, provider, provider_finding_id, table_name, verdict, problem, finding_count, severity, observed_at, raw->>'disposition' as disposition
     from cm.quality_findings order by observed_at desc, id limit 500`);
  const attempts = await tx.query<AttemptRow>(
    `select a.id, a.run_id, a.attempt_no, a.kind, a.created_at, o.id as output_id, o.output_sha256, o.body
     from cm.attempts a left join cm.outputs o on o.attempt_id = a.id
     order by a.created_at desc, a.id limit 300`);
  const evidence = await tx.query<EvidenceRow>(
    // The model comes from the transport receipt. declared_agent_model is a legacy label and is never read.
    `select id, output_id, kind, uri, sha256, created_by, created_at, payload->>'historical_label' as historical_label,
       case when kind = 'hermes_transport' then payload->'receipt'->>'served_model' end as served_model
     from cm.evidence order by created_at desc, id limit 600`);
  const approvals = await tx.query<ApprovalRow>(`select evaluation_id, decision, approver, created_at from cm.approvals`);
  const pins = await tx.query<PinRow>(`select run_id, decision_id from cm.run_decisions`);
  return { readAt: now, runs, chains, decisions, sources, evaluations, gates, quality, attempts, evidence, approvals, pins };
}

export interface SourceFreshness { asOf: string | null; ageDays: number | null; mirrorRunId: string | null }

/** How old the gym data underneath is. In its own transaction: a missing table must not blank the board. */
export async function readSourceFreshness(): Promise<SourceFreshness> {
  const empty = { asOf: null, ageDays: null, mirrorRunId: null };
  try {
    return await withRole('dashboard_reader', async (tx) => {
      const [sync] = await tx.query<{ as_of: string | null; age: number | null }>(
        `select max(report_as_of)::text as as_of, (current_date - max(report_as_of))::int as age
         from gym.ezf_active_membership_sync_runs where status = 'complete'`);
      const [mirror] = await tx.query<{ id: string }>(`select id::text as id from gym.mirror_runs order by finished_at desc nulls last limit 1`);
      return { asOf: sync?.as_of ?? null, ageDays: sync?.age ?? null, mirrorRunId: mirror?.id ?? null };
    });
  } catch {
    return empty;
  }
}

export const readRecords = () => withRole('dashboard_reader', readAll);

/** The evaluations the gate reads: latest attempt of each run, newest per check, same tie-break as cm.gate_missing. */
export function countedEvaluationIds(r: Records): Set<string> {
  const current = new Set(r.runs.map((x) => x.attempt_id));
  const seen = new Set<string>();
  const counted = new Set<string>();
  for (const e of r.evaluations) { // Already ordered created_at desc, id desc.
    const key = `${e.attempt_id}/${e.check_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (current.has(e.attempt_id)) counted.add(e.id);
  }
  return counted;
}

/** Which model actually served a run, from its transport receipts. Null when no receipt names one. */
export function servedModel(r: Records, runId: string | null | undefined): string | null {
  const outputs = new Set(r.attempts.filter((a) => a.run_id === runId).map((a) => a.output_id));
  const models = new Set(r.evidence.filter((e) => e.served_model && outputs.has(e.output_id)).map((e) => e.served_model));
  return models.size ? [...models].join(', ') : null;
}

/** A replayed historical line goes through the normal checks, but no model wrote it. */
export function isReplay(body: Record<string, unknown> | null | undefined): boolean {
  const p = body?.provenance as { kind?: unknown; model_generated?: unknown } | undefined;
  return p?.kind === 'historical_replay' || p?.model_generated === false;
}
export const isReplayRun = (r: Records, runId: string | null | undefined) =>
  r.attempts.some((a) => a.run_id === runId && isReplay(a.body));

/** The label the Milo handler records in evidence when its input is a historical excerpt. */
export const historicalLabel = (r: Records, outputId: string | null | undefined): string | null =>
  r.evidence.find((e) => e.output_id === outputId && e.historical_label)?.historical_label ?? null;

/** An excerpt found only in the historical `before` text is the input being quoted, not new drift. */
function quotesOnlyInput(body: Record<string, unknown> | null | undefined, excerpt: string): boolean {
  const before = typeof body?.before === 'string' ? body.before : '';
  const after = typeof body?.after === 'string' ? body.after : '';
  return before.includes(excerpt) && !after.includes(excerpt);
}

export interface Chain {
  row: ChainRow;
  decision: DecisionRow | null;
  source: SourceRow | null;
  conflictAttempt: AttemptRow | null;
  conflictRun: RunRow | null;
  conflictIsHistoricalInput: boolean;
  conflictIsReplay: boolean;
  correctionIsNewVersion: boolean;
  failedEvaluation: EvaluationRow | null;
  rejection: GateRow | null;
  repairAttempt: AttemptRow | null;
  repairEvaluation: EvaluationRow | null;
  repairGate: GateRow | null;
  correction: DecisionRow | null;
  freshRun: RunRow | null;
  freshIsNewRun: boolean;
  freshPinsCorrection: boolean;
  freshEvaluations: EvaluationRow[];
  freshGate: GateRow | null;
  proven: boolean;
}

export function buildChain(r: Records, row: ChainRow): Chain {
  const decision = r.decisions.find((d) => d.decision_key === row.decision_key && d.version === row.decision_version) ?? null;
  const source = decision ? r.sources.find((s) => s.id === decision.source_id) ?? null : null;
  const conflictAttempt = r.attempts.find((a) => a.output_id === row.target_output_id) ?? null;
  const conflictRun = conflictAttempt ? r.runs.find((x) => x.run_id === conflictAttempt.run_id) ?? null : null;
  const failedEvaluation = r.evaluations.find((e) => e.output_id === row.target_output_id && e.verdict === 'fail') ?? null;
  const rejection = conflictAttempt
    ? r.gates.find((g) => g.attempt_id === conflictAttempt.id && g.verdict === 'blocked') ?? null
    : null;
  const repairAttempt = conflictAttempt
    ? r.attempts
        .filter((a) => a.run_id === conflictAttempt.run_id && a.kind === 'repair' && a.attempt_no > conflictAttempt.attempt_no)
        .sort((a, b) => b.attempt_no - a.attempt_no)[0] ?? null
    : null;
  const repairEvaluation = repairAttempt?.output_id
    ? r.evaluations.find((e) => e.output_id === repairAttempt.output_id) ?? null
    : null;
  const repairGate = repairAttempt ? r.gates.find((g) => g.attempt_id === repairAttempt.id) ?? null : null;
  const correction = row.correction_decision_id ? r.decisions.find((d) => d.id === row.correction_decision_id) ?? null : null;
  const freshRun = row.verifying_run_id ? r.runs.find((x) => x.run_id === row.verifying_run_id) ?? null : null;
  const freshIsNewRun = !!freshRun && freshRun.run_id !== conflictAttempt?.run_id;
  const freshPinsCorrection = !!freshRun && !!correction
    && r.pins.some((p) => p.run_id === freshRun.run_id && p.decision_id === correction.id);
  const counted = countedEvaluationIds(r);
  const freshEvaluations = freshRun?.attempt_id ? r.evaluations.filter((e) => e.attempt_id === freshRun.attempt_id && counted.has(e.id)) : [];
  const freshGate = freshRun ? r.gates.find((g) => g.run_id === freshRun.run_id) ?? null : null;
  const proven = row.status === 'verified' && freshIsNewRun && freshRun?.status === 'completed' && freshPinsCorrection;
  const conflictIsHistoricalInput = !!historicalLabel(r, row.target_output_id) && quotesOnlyInput(conflictAttempt?.body, row.excerpt);
  const conflictIsReplay = isReplay(conflictAttempt?.body);
  const correctionIsNewVersion = !!correction && correction.id !== decision?.id;
  return { row, decision, source, conflictAttempt, conflictRun, conflictIsHistoricalInput, conflictIsReplay, correctionIsNewVersion, failedEvaluation, rejection, repairAttempt, repairEvaluation, repairGate, correction, freshRun, freshIsNewRun, freshPinsCorrection, freshEvaluations, freshGate, proven };
}

export function newest(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}
