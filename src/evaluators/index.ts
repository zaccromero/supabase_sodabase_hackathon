import { sha256 } from '../contract/hash';
import type { CheckSpec, EvaluationBinding, EvaluationResult, Evaluator, PinnedDecision, Profile } from '../contract/types';
import { canonicalCheck, frozenChecksHash, type EvaluationContext } from './adapter';
import { EVALUATION_RECEIPT_KIND, makeResult, nonEmptyString } from './common';
import { createCriticEvaluator, type CriticDeps } from './critic';
import { createDriftFindingsEvaluator, type DriftEvaluatorDeps } from './drift';
import { createGymDataAgeEvaluator, createGymDefinitionEvaluator, DEFINITION_SPEC, type GymEvaluatorDeps } from './gym';
import { createPgGymSource, type Queryable } from './gym-source';
import { createClaimsSourcedEvaluator, createForbiddenClaimEvaluator, DECK_SOURCE_KEYS, DECK_SOURCE_PREFIXES, forbiddenRulesFor } from './milo';

export * from './adapter';
export * from './core';
export * from './critic';
export * from './drift';
export * from './gym';
export * from './gym-source';
export * from './milo';
export * from './storage';

export const DECISION_KEYS = {
  gymDefinition: 'gym.active_individual_definition',
  gymFreshness: 'gym.freshness_completeness',
  miloPartner: 'milo.gym_nyc_partner',
  miloFee: 'milo.fee_not_collected',
  miloAlpha: 'milo.alpha_not_usage',
  miloPositioning: 'milo.current_positioning',
} as const;

const byKey = (decisions: PinnedDecision[], key: string) => decisions.find((d) => d.decision_key === key);
const bound = (d: PinnedDecision | undefined) => (d ? { decision_id: d.id } : {});
const decisionRef = (d: PinnedDecision | undefined) => (d ? { decision_key: d.decision_key, decision_version: d.version } : {});

function criticCheck(decision: PinnedDecision | undefined, required: boolean): CheckSpec[] {
  if (!decision) return [];
  return [{
    check_id: 'critic.meaning', kind: 'critic', required, requires_evidence: true, decision_id: decision.id,
    spec: { decision_id: decision.id, ...decisionRef(decision) },
  }];
}

export interface ChecksOptions { criticDecisionKey?: string; }

/**
 * Checks to freeze into a run's contract, bound to accepted decisions by key. Pass the pinned decisions in every
 * memory mode: a baseline run withholds them from the handler, not from the checks. Deterministic gym and Milo
 * checks stay required when their decision is absent, so a missing pin cannot remove a check.
 */
export function checksFor(profile: Profile, decisions: PinnedDecision[], options: ChecksOptions = {}): CheckSpec[] {
  const pick = (fallback: string) => byKey(decisions, options.criticDecisionKey ?? fallback);
  switch (profile) {
    case 'gym_operator': {
      const definition = byKey(decisions, DECISION_KEYS.gymDefinition);
      const freshness = byKey(decisions, DECISION_KEYS.gymFreshness);
      return [
        { check_id: 'gym.canonical_definition', kind: 'deterministic', required: true, requires_evidence: true, ...bound(definition), spec: { ...DEFINITION_SPEC, ...decisionRef(definition) } },
        { check_id: 'gym.data_age_reported', kind: 'deterministic', required: true, requires_evidence: true, ...bound(freshness), spec: { age_tolerance_days: 1, ...decisionRef(freshness) } },
        // Counts are already verified deterministically, so the gym critic is recorded and does not block.
        ...criticCheck(pick(DECISION_KEYS.gymDefinition), false),
      ];
    }
    case 'milo_pitch': {
      const rules = forbiddenRulesFor(decisions);
      return [
        { check_id: 'milo.no_forbidden_claim', kind: 'deterministic', required: true, requires_evidence: true, ...(rules[0] ? { decision_id: rules[0].decision_id } : {}), spec: { rules } },
        { check_id: 'milo.claims_sourced', kind: 'deterministic', required: true, requires_evidence: true, spec: { allowed_sources: DECK_SOURCE_KEYS, allowed_source_prefixes: DECK_SOURCE_PREFIXES } },
        ...criticCheck(pick(DECISION_KEYS.miloPartner), true),
      ];
    }
    case 'drift_reviewer':
      return [{ check_id: 'drift.findings_cited', kind: 'deterministic', required: true, requires_evidence: true, spec: {} }];
  }
}

export type EvaluatorDeps = GymEvaluatorDeps & CriticDeps & DriftEvaluatorDeps & {
  /** Trusted state from evaluator_service. When present, the frozen contract and worker separation are verified too. */
  loadContext?: (binding: EvaluationBinding) => Promise<EvaluationContext>;
  evaluatorId?: string;
};

/**
 * Refuses to judge anything but the bound output against the frozen contract, and turns an evaluator crash into
 * `uncertain`. The database enforces the same binding again on insert.
 */
export function guarded(evaluator: Evaluator, name: string, deps: EvaluatorDeps = {}): Evaluator {
  return async (input) => {
    const { binding, check, output } = input;
    const unbound = (['run_id', 'attempt_id', 'output_id', 'contract_id', 'output_sha256', 'contract_sha256'] as Array<keyof EvaluationBinding>).filter((k) => !nonEmptyString(binding[k]));
    if (unbound.length) return makeResult(input, name, 'fail', `BINDING_INCOMPLETE: ${unbound.join(', ')}`);
    if (sha256(output) !== binding.output_sha256) return makeResult(input, name, 'fail', 'BINDING_OUTPUT_HASH_MISMATCH: the output is not the one this evaluation is bound to');
    try {
      if (deps.loadContext) {
        const context = await deps.loadContext(binding);
        if (!Number.isFinite(Date.parse(context.frozenAt))) return makeResult(input, name, 'fail', 'CONTRACT_NOT_FROZEN');
        if (frozenChecksHash(context.checks) !== binding.contract_sha256) return makeResult(input, name, 'fail', 'BINDING_CONTRACT_HASH_MISMATCH: the checks are not the frozen ones');
        if (!context.checks.some((c) => canonicalCheck(c) === canonicalCheck(check))) return makeResult(input, name, 'fail', 'BINDING_UNKNOWN_CHECK: this check is not in the frozen contract');
        if (!nonEmptyString(context.editingAgentId) || context.editingAgentId === (deps.evaluatorId ?? name)) return makeResult(input, name, 'fail', 'SELF_EVALUATION: the editing agent cannot evaluate its own output');
        if (check.requires_evidence && context.evidence.length === 0) return makeResult(input, name, 'fail', 'NO_SOURCE_EVIDENCE: the attempt recorded no evidence to check against');
      }
      return await evaluator(input);
    } catch (e) {
      return makeResult(input, name, 'uncertain', `Evaluator error: ${(e as Error).name}`);
    }
  };
}

export function createRegistry(deps: EvaluatorDeps = {}): Record<string, Evaluator> {
  const entry = (name: string, evaluator: Evaluator) => guarded(evaluator, name, deps);
  return {
    'gym.canonical_definition': entry('det.gym_definition', createGymDefinitionEvaluator(deps)),
    'gym.data_age_reported': entry('det.gym_data_age', createGymDataAgeEvaluator(deps)),
    'milo.no_forbidden_claim': entry('det.milo_forbidden', createForbiddenClaimEvaluator()),
    'milo.claims_sourced': entry('det.milo_claims', createClaimsSourcedEvaluator()),
    'critic.meaning': entry('critic.meaning', createCriticEvaluator(deps)),
    'drift.findings_cited': entry('det.drift_findings', createDriftFindingsEvaluator(deps)),
  };
}

/** Structural match for the runner's Db (src/runner/db.ts), so this lane has no import on the runner lane. */
export interface RoleTx { query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>; }
export interface RoleDb { withRole<T>(role: 'evaluator_service', fn: (tx: RoleTx) => Promise<T>): Promise<T>; }

export interface StoredRegistryOptions extends CriticDeps {
  /** Who produced the output under review. Must differ from every evaluator identity. */
  editingAgentId?: string;
  /** Schema of the gym mirror the evaluators recount from. */
  gymSchema?: string;
  now?: () => Date;
}

/**
 * The registry to hand the runner. Every read goes through evaluator_service: frozen checks, source evidence, the
 * reviewed output and the gym projection. The runner persists each returned result as evaluator_service.
 */
export function createStoredRegistry(db: RoleDb, options: StoredRegistryOptions = {}): Record<string, Evaluator> {
  const asQueryable: Queryable = { query: (text, params) => db.withRole('evaluator_service', async (tx) => ({ rows: await tx.query(text, params) })) };
  return createRegistry({
    ...options,
    gymSource: createPgGymSource(asQueryable, { schema: options.gymSchema ?? 'gym' }),
    targetOutputBody: async (id) => {
      const { rows } = await asQueryable.query(`select body from cm.outputs where id::text = $1`, [id]);
      return rows[0]?.body ?? null;
    },
    loadContext: (binding) => db.withRole('evaluator_service', async (tx) => {
      const [row] = await tx.query<{ frozen_at: unknown; output_sha256: string; contract_sha256: string; attempt_id: string; contract_id: string }>(
        `select c.frozen_at, o.output_sha256, c.contract_sha256, a.id attempt_id, c.id contract_id
         from cm.outputs o join cm.attempts a on a.id = o.attempt_id join cm.check_contracts c on c.id = a.contract_id
         where o.id = $1::uuid and a.run_id = $2::uuid`, [binding.output_id, binding.run_id]);
      if (!row) throw new Error('Bound output not found');
      if (row.output_sha256 !== binding.output_sha256 || row.contract_sha256 !== binding.contract_sha256 || row.attempt_id !== binding.attempt_id || row.contract_id !== binding.contract_id) {
        throw new Error('Stored binding mismatch');
      }
      const checks = await tx.query<CheckSpec>(`select check_id, kind, required, requires_evidence, decision_id, spec from cm.contract_checks where contract_id = $1::uuid order by check_id`, [binding.contract_id]);
      const evidence = await tx.query<{ id: string; kind: string; payload: unknown; uri: unknown; created_by: unknown }>(
        `select id, kind, payload, uri, created_by from cm.evidence where output_id = $1::uuid and kind <> $2 order by created_at, id`, [binding.output_id, EVALUATION_RECEIPT_KIND]);
      return {
        frozenAt: row.frozen_at instanceof Date ? row.frozen_at.toISOString() : String(row.frozen_at ?? ''),
        checks: checks.map((c) => ({ ...c, decision_id: c.decision_id ?? undefined })) as CheckSpec[],
        editingAgentId: options.editingAgentId ?? 'agent_worker',
        evidence: evidence.map((e) => ({ id: e.id, binding, kind: e.kind, text: JSON.stringify({ payload: e.payload, uri: e.uri, created_by: e.created_by }) })),
      };
    }),
    evaluatorId: 'evaluator_service',
  });
}

/** Inserts evidence, then the evaluation. The connection must already be acting as evaluator_service. */
export async function recordEvaluation(db: Queryable, binding: EvaluationBinding, result: EvaluationResult): Promise<{ evaluation_id: string; evidence_id: string | null }> {
  let evidenceId: string | null = null;
  if (result.evidence) {
    const { kind, uri, sha256: hash, payload } = result.evidence;
    const r = await db.query(
      `insert into cm.evidence (output_id, kind, uri, sha256, payload, created_by) values ($1,$2,$3,$4,$5::jsonb,$6) returning id`,
      [binding.output_id, kind, uri ?? null, hash ?? null, JSON.stringify(payload), result.evaluator]);
    evidenceId = r.rows[0].id;
  }
  const e = await db.query(
    `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [binding.run_id, binding.attempt_id, binding.output_id, binding.contract_id, result.check_id, binding.output_sha256, binding.contract_sha256, result.evaluator, result.evaluator_version, result.verdict, result.reason, evidenceId]);
  return { evaluation_id: e.rows[0].id, evidence_id: evidenceId };
}
