// Shared contract. Change only through the integration owner (see docs/CONTRACT.md).
export type Profile = 'gym_operator' | 'milo_pitch' | 'drift_reviewer';
export type Verdict = 'pass' | 'fail' | 'uncertain';
export type DbRole = 'agent_worker' | 'evaluator_service' | 'gate_service' | 'founder_approver' | 'dashboard_reader';

export interface PinnedDecision { id: string; decision_key: string; version: number; statement: string; source_uri: string; source_historical: boolean; }
export interface EvidenceInput { kind: string; uri?: string; sha256?: string; payload: Record<string, unknown>; }

/** Lane 3 implements. Runs as agent_worker. Never touches evaluations, runs or contracts. */
export interface HandlerResult { body: Record<string, unknown>; evidence: EvidenceInput[]; }
export type Handler = (input: { runId: string; attemptNo: number; task: string; decisions: PinnedDecision[]; repairNotes?: string[]; technique?: Record<string, unknown> }) => Promise<HandlerResult>;

export interface CheckSpec { check_id: string; kind: 'deterministic' | 'critic'; required: boolean; requires_evidence: boolean; decision_id?: string; spec: Record<string, unknown>; }

/** Binding every evaluation must carry. Mismatch is rejected by the database. */
export interface EvaluationBinding { run_id: string; attempt_id: string; output_id: string; contract_id: string; output_sha256: string; contract_sha256: string; }
export interface EvaluationResult { check_id: string; verdict: Verdict; reason: string; evaluator: string; evaluator_version: string; evidence?: EvidenceInput; }

/** Lane 4 implements. Runs as evaluator_service. */
export type Evaluator = (input: { binding: EvaluationBinding; check: CheckSpec; output: Record<string, unknown>; decisions: PinnedDecision[] }) => Promise<EvaluationResult>;

export type GateVerdict = 'completed' | 'blocked' | 'awaiting_approval';
export interface GateResult { run_id: string; verdict: GateVerdict; missing: Array<{ check_id?: string; reason: string; evaluation_id?: string }>; }

export const CANONICAL_JSON_NOTE = 'output_sha256 and contract_sha256 are sha256 of canonicalJson() from src/contract/hash.ts';
