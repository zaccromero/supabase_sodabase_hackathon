import type { Evaluator } from '../contract/types';
import { isRecord, makeResult, nonEmptyString, normalizeText, textLeaves } from './common';

export interface DriftEvaluatorDeps {
  /** Reads the reviewed output independently, so an excerpt the reviewer invented cannot pass. */
  targetOutputBody?: (outputId: string) => Promise<Record<string, unknown> | null>;
}

/** A drift review must point at real text and a pinned decision. Nothing is checked about whether drift matters. */
export function createDriftFindingsEvaluator(deps: DriftEvaluatorDeps = {}): Evaluator {
  const name = 'det.drift_findings';
  return async (input) => {
    const { output, decisions } = input;
    if (!Array.isArray(output.findings)) return makeResult(input, name, 'fail', 'Output has no findings array');
    const pinned = new Set(decisions.map((d) => d.id));
    if (output.findings.length === 0) {
      // A clean review only counts if it actually covered every pinned decision.
      const reviewed = new Set((Array.isArray(output.decisions_reviewed) ? output.decisions_reviewed : []).filter(isRecord).map((d) => d.id));
      const covered = pinned.size > 0 && [...pinned].every((id) => reviewed.has(id));
      return covered
        ? makeResult(input, name, 'pass', `Review covered ${pinned.size} pinned decision(s) and reports no contradiction`, { findings: 0, decisions_reviewed: pinned.size })
        : makeResult(input, name, 'uncertain', 'Empty review does not show every pinned decision was covered', { findings: 0, pinned: pinned.size });
    }
    const failures: string[] = [];
    let verifiedExcerpts = 0;
    for (const [i, f] of output.findings.entries()) {
      if (!isRecord(f)) { failures.push(`finding ${i} is malformed`); continue; }
      const target = f.target_output_id ?? output.target_output_id;
      const missing = ['decision_id', 'excerpt', 'explanation', 'proposed_repair'].filter((k) => !nonEmptyString(f[k]));
      if (!nonEmptyString(target)) missing.unshift('target_output_id');
      if (missing.length) { failures.push(`finding ${i} lacks ${missing.join(', ')}`); continue; }
      if (!pinned.has(f.decision_id as string)) { failures.push(`finding ${i} cites a decision not pinned to this run`); continue; }
      if (deps.targetOutputBody) {
        const body = await deps.targetOutputBody(target as string);
        if (!body) { failures.push(`finding ${i} targets an unknown output`); continue; }
        const quote = normalizeText(f.excerpt as string);
        if (!textLeaves(body).some((leaf) => normalizeText(leaf).includes(quote))) { failures.push(`finding ${i} excerpt does not appear in the target output`); continue; }
        verifiedExcerpts++;
      }
    }
    const payload = { findings: output.findings.length, verified_excerpts: verifiedExcerpts, failures };
    if (failures.length) return makeResult(input, name, 'fail', failures.join('; '), payload);
    if (!deps.targetOutputBody) return makeResult(input, name, 'uncertain', 'Findings cite pinned decisions, but no reader was available to confirm the excerpts', payload);
    return makeResult(input, name, 'pass', `${output.findings.length} finding(s) cite pinned decisions and real excerpts`, payload);
  };
}
