import type { Evaluator } from '../contract/types';
import { daysBetween, isRecord, makeResult, nonEmptyString, toNyDate } from './common';
import { analyzeDefinitionSql } from './sql';

/**
 * Canonical definition, read-only source: gym-nyc apps/web/lib/member-contract.ts and
 * apps/web/lib/db/queries/owner-membership.ts. Used only by the evaluators, independently of the agent's own claims.
 */
export interface GymSource {
  /** location_id to report_as_of of the latest complete projection. A location with no complete latest run is absent. */
  dataAsOf(): Promise<Record<string, string>>;
  /** location_id to canonical MATCHED_INDIVIDUAL count. Aggregates only. */
  canonicalCounts?(): Promise<Record<string, number>>;
}

export interface GymEvaluatorDeps { gymSource?: GymSource; now?: () => Date; }

export const DEFINITION_SPEC = {
  table: 'ezf_active_memberships',
  runs_table: 'ezf_active_membership_sync_runs',
  bridge_class: 'MATCHED_INDIVIDUAL',
  canonical_source: 'gym-nyc:apps/web/lib/member-contract.ts',
} as const;

type AnswerRow = { location_id: string; active_individual_members: number | null };

/** null means unknown, which gym.freshness_completeness requires over a fabricated zero. */
function answerRows(output: Record<string, unknown>): AnswerRow[] | null {
  if (!Array.isArray(output.answer) || output.answer.length === 0) return null;
  const rows = output.answer.filter(isRecord);
  if (rows.length !== output.answer.length) return null;
  const count = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);
  if (!rows.every((r) => nonEmptyString(r.location_id) && count(r.active_individual_members))) return null;
  return rows as unknown as AnswerRow[];
}

export function createGymDefinitionEvaluator(deps: GymEvaluatorDeps = {}): Evaluator {
  const name = 'det.gym_definition';
  return async (input) => {
    const { check, output } = input;
    const spec = {
      table: String(check.spec.table ?? DEFINITION_SPEC.table),
      runsTable: String(check.spec.runs_table ?? DEFINITION_SPEC.runs_table),
      bridgeClass: String(check.spec.bridge_class ?? DEFINITION_SPEC.bridge_class),
    };
    const done = (verdict: 'pass' | 'fail' | 'uncertain', reason: string, extra: Record<string, unknown> = {}) =>
      makeResult(input, name, verdict, reason, { canonical_source: DEFINITION_SPEC.canonical_source, ...extra });

    if (!nonEmptyString(output.sql)) return done('fail', 'Output reports no SQL, so the definition cannot be verified');
    const a = analyzeDefinitionSql(output.sql, spec);
    const facts = { analysis: a };

    if (!a.readsProjection || a.negatedProjection) {
      return done('fail', a.usesChurnedAt
        ? `Counted churned_at IS NULL, not ${spec.bridgeClass} from ${spec.table}`
        : `SQL does not read ${spec.table}`, facts);
    }
    if (!a.canonicalClass) return done('fail', `SQL does not filter bridge_class = '${spec.bridgeClass}'`, facts);
    if (!a.readsRuns || !a.completeStatus) return done('fail', `SQL does not bind to a complete run in ${spec.runsTable}`, facts);

    const definition = typeof output.definition === 'string' ? output.definition : '';
    if (!definition.includes(spec.bridgeClass)) return done('fail', `Reported definition does not name ${spec.bridgeClass}`, facts);

    const rows = answerRows(output);
    if (!rows) return done('fail', 'Answer has no well-formed location counts', facts);

    const doubts: string[] = [];
    if (!a.selectsLatest) doubts.push('complete run is referenced but selecting the latest one is not proven');
    if (a.otherClassComparison) doubts.push('SQL also compares bridge_class to other values');
    if (a.usesChurnedAt) doubts.push('SQL adds churned_at on top of the projection, which can narrow the canonical count');
    if (a.hasOr) doubts.push('SQL uses OR, which can widen the canonical filter');
    if (a.hasSetOperation) doubts.push('SQL uses a set operation, which can add rows outside the filter');

    let recomputed: Record<string, number> | null = null;
    if (deps.gymSource?.canonicalCounts) {
      try {
        recomputed = await deps.gymSource.canonicalCounts();
      } catch (e) {
        return done('uncertain', `Independent recount failed: ${(e as Error).name}`, facts);
      }
      const wrong = rows.filter((r) => (recomputed![r.location_id] ?? null) !== r.active_individual_members);
      if (wrong.length) {
        return done('fail', `Reported count differs from the independent canonical recount for ${wrong.map((r) => r.location_id).join(', ')}`, {
          ...facts, recomputed, reported: rows,
        });
      }
    }
    const extra = { ...facts, independent_recount: recomputed !== null, recomputed, reported: rows };
    if (doubts.length) return done('uncertain', doubts.join('; '), extra);
    return done('pass', `SQL reads ${spec.table} with ${spec.bridgeClass} on the latest complete projection${recomputed ? ' and counts match an independent recount' : ''}`, extra);
  };
}

export function createGymDataAgeEvaluator(deps: GymEvaluatorDeps = {}): Evaluator {
  const name = 'det.gym_data_age';
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const { check, output } = input;
    const done = (verdict: 'pass' | 'fail' | 'uncertain', reason: string, extra: Record<string, unknown> = {}) =>
      makeResult(input, name, verdict, reason, extra);

    if (!nonEmptyString(output.data_as_of)) return done('fail', 'Output does not state data_as_of');
    const reported = toNyDate(output.data_as_of);
    if (!reported) return done('fail', 'data_as_of is not a date');
    if (!Number.isInteger(output.data_age_days) || (output.data_age_days as number) < 0) return done('fail', 'Output does not state a whole data_age_days');

    // The expected value comes from the source, never from the agent's output or evidence.
    let sourceDates: Record<string, string>;
    if (deps.gymSource) {
      try {
        sourceDates = await deps.gymSource.dataAsOf();
      } catch (e) {
        return done('uncertain', `Source could not be read: ${(e as Error).name}`);
      }
    } else if (isRecord(check.spec.source_data_as_of)) {
      sourceDates = check.spec.source_data_as_of as Record<string, string>;
    } else {
      return done('uncertain', 'No independent source available to confirm data_as_of');
    }

    const rows = answerRows(output);
    // gym.freshness_completeness: a location without a complete projection is unknown, never a number.
    const fabricated = (rows ?? []).filter((r) => !sourceDates[r.location_id] && r.active_individual_members !== null);
    if (fabricated.length) {
      return done('fail', `Reported a count for ${fabricated.map((r) => r.location_id).join(', ')}, which has no latest complete projection`, { source_dates: sourceDates });
    }
    const counted = rows ? rows.filter((r) => r.active_individual_members !== null).map((r) => r.location_id) : Object.keys(sourceDates);
    const locations = counted.filter((l) => sourceDates[l]);
    if (locations.length === 0) {
      return done('uncertain', 'Source has no latest complete projection for the locations in this answer', { source_dates: sourceDates });
    }
    // A multi-location answer is only as fresh as its oldest location.
    const expected = locations.map((l) => toNyDate(sourceDates[l]!)!).sort()[0]!;
    if (reported !== expected) {
      return done('fail', `Reported data_as_of ${reported} does not match source ${expected}`, { reported, expected, source_dates: sourceDates });
    }
    const today = toNyDate(now().toISOString())!;
    const actualAge = daysBetween(expected, today);
    const tolerance = Number(check.spec.age_tolerance_days ?? 1);
    if (Math.abs((output.data_age_days as number) - actualAge) > tolerance) {
      return done('fail', `Reported data_age_days ${output.data_age_days} does not match actual age ${actualAge}`, { reported, expected, actual_age_days: actualAge });
    }
    return done('pass', `data_as_of ${reported} matches the source; age ${actualAge} day(s)`, { reported, expected, actual_age_days: actualAge, source_dates: sourceDates });
  };
}
