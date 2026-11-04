import type { Evaluator, PinnedDecision } from '../contract/types';
import { isRecord, makeResult, nonEmptyString, normalizeText } from './common';

/** Stored in the frozen check spec, so the phrase list is part of contract_sha256. */
export interface ForbiddenRule {
  rule_id: string;
  decision_id: string;
  decision_key: string;
  decision_version: number;
  label: string;
  patterns: string[];
  proposed_repair: string;
}

interface RuleTemplate {
  rule_id: string;
  decision_key: string;
  label: string;
  patterns: string[];
  proposed_repair: string;
}

/**
 * Bound to accepted decision keys by exact match. A rule with no pinned decision is not applied, and a decision's
 * wording can never activate one. Patterns run on normalizeText() output, so they are lower case.
 * Owner correction, 2 Nov 2026: memo v1 and deck v3 still call Gym NYC the founder's gym; those are historical.
 */
const RULE_TEMPLATES: RuleTemplate[] = [
  {
    rule_id: 'gym_nyc_not_founders_gym',
    decision_key: 'milo.gym_nyc_partner',
    label: "Describes Gym NYC as the founder's own gym",
    patterns: [
      "\\b(?:the\\s+)?founder'?s\\s+(?:own\\s+)?(?:[\\w-]+\\s+)?gym\\b",
      '\\bfounder[- ]owned\\s+gym\\b',
      '\\bfounder[- ](?:owned|run)\\b[^.]{0,40}\\bgym nyc\\b',
      '\\bgym nyc\\b[^.]{0,60}\\b(?:the\\s+)?founder\\s+(?:owns|owned)\\b',
      '\\b(?:founder|zacc)\\b[^.]{0,30}\\b(?:owns|owned)\\b[^.]{0,40}\\bgym nyc\\b',
      '\\b(?:our|my)\\s+own\\s+gym\\b',
      '\\b(?:our|my)\\s+gym\\b(?!\\s+partner)',
      '\\b(?:we|i)\\s+(?:own|owned)\\s+gym nyc\\b',
      '\\bgym nyc\\b,?\\s+(?:which\\s+|that\\s+)?(?:we|i)\\s+(?:own|owned)\\b',
    ],
    proposed_repair: 'Describe Gym NYC as a partner',
  },
  {
    rule_id: 'fee_not_collected_revenue',
    decision_key: 'milo.fee_not_collected',
    label: 'Describes the fee as collected revenue',
    patterns: [
      '\\bfees?\\b[^.]{0,60}\\bcollected\\s+revenue\\b',
      '\\bcollected\\s+revenue\\b[^.]{0,60}\\bfees?\\b',
      '\\bcollected\\s+fees?\\b',
      '\\bfees?\\b[^.]{0,30}\\b(?:is|are|was|were|been|already|being)\\s+(?:already\\s+)?collected\\b',
      '\\b(?:collecting|collect)\\s+(?:the\\s+|a\\s+|its\\s+|our\\s+)?[^.]{0,20}\\bfees?\\b',
      '\\bfees?\\b[^.]{0,40}\\b(?:booked|recognized|realized)\\s+(?:as\\s+)?revenue\\b',
      '\\bfees?\\b[^.]{0,30}\\bcounts?\\s+as\\s+revenue\\b',
    ],
    proposed_repair: 'State the fee as founder-reported and conditional, not collected revenue',
  },
  {
    rule_id: 'alpha_not_usage',
    decision_key: 'milo.alpha_not_usage',
    label: 'Presents the controlled alpha as enrollment, usage, deployment or certification',
    patterns: [
      '\\b(?:active|enrolled|weekly|daily|monthly|paying)\\s+(?:users?|athletes?)\\b',
      '\\b(?:users?|athletes?|members?)\\s+(?:are\\s+)?(?:already\\s+)?(?:using|enrolled|active on)\\b',
      '\\balpha\\b[^.]{0,60}\\b(?:proves?|proof|shows?|demonstrates?|validates?|validated)\\b[^.]{0,40}\\b(?:usage|adoption|enrollment|traction|demand|retention|engagement)\\b',
      '\\b(?:usage|adoption|enrollment|retention|engagement)\\s+(?:data|metrics?|numbers?|growth)\\b',
      '\\b(?:live|deployed)\\s+(?:at|across|in|to)\\s+(?:\\d+|two|three|four|all)\\s+(?:\\w+\\s+)?(?:sites|gyms|locations)\\b',
      '\\b(?:zero|0)\\s+(?:enrolled|enrollment|users?|athletes?)\\b',
      '\\benrollment\\s+(?:is\\s+)?(?:zero|0)\\b',
      '\\b(?:alpha|app)\\b[^.]{0,40}\\bcertified\\b',
    ],
    proposed_repair: 'State the controlled alpha scope only; enrollment and usage are unknown',
  },
  {
    rule_id: 'unshipped_agents_not_live',
    decision_key: 'milo.current_positioning',
    label: 'Describes unshipped organization agents as live',
    patterns: [
      '\\bagents?\\b[^.]{0,40}\\b(?:are|is)\\s+(?:now\\s+|already\\s+)?(?:live|shipped|deployed|in production)\\b',
      '\\blive\\s+(?:organization\\s+|org\\s+|operator\\s+)?agents?\\b',
      '\\bagents?\\s+(?:already\\s+|now\\s+)?(?:run|runs|manage|manages|operate|operates)\\b[^.]{0,30}\\b(?:gyms?|operators?|locations?)\\b',
    ],
    proposed_repair: 'Say organization agents for athletics operators are being built',
  },
];

export function forbiddenRulesFor(decisions: PinnedDecision[]): ForbiddenRule[] {
  const rules: ForbiddenRule[] = [];
  for (const t of RULE_TEMPLATES) {
    const d = decisions.find((x) => x.decision_key === t.decision_key);
    if (!d) continue;
    rules.push({
      rule_id: t.rule_id, decision_id: d.id, decision_key: d.decision_key, decision_version: d.version,
      label: t.label, patterns: t.patterns, proposed_repair: t.proposed_repair,
    });
  }
  return rules;
}

/** Text the output asserts. `before` is the wording being replaced, so it may legitimately hold the old claim. */
function assertedText(output: Record<string, unknown>): Array<{ field: string; text: string }> {
  const parts: Array<{ field: string; text: string }> = [];
  if (typeof output.after === 'string') parts.push({ field: 'after', text: output.after });
  if (Array.isArray(output.claims)) {
    output.claims.forEach((c, i) => {
      if (isRecord(c) && typeof c.text === 'string') parts.push({ field: `claims[${i}].text`, text: c.text });
    });
  }
  return parts;
}

// "not only" and "not just" keep the claim alive, so they do not count as negation.
const NEGATED = /(?:\b(?:not|never|no|without|isn't|wasn't|aren't|rather than|instead of|no longer)\s+(?!only\b|just\b|merely\b|simply\b)(?:\w+\s+){0,2})$/;

export function createForbiddenClaimEvaluator(): Evaluator {
  const name = 'det.milo_forbidden';
  return async (input) => {
    const { check, output, decisions } = input;
    const rules = (Array.isArray(check.spec.rules) ? check.spec.rules : []) as ForbiddenRule[];
    if (rules.length === 0) return makeResult(input, name, 'uncertain', 'No forbidden-claim rules are pinned for this run, so nothing was verified');
    if (!nonEmptyString(output.after)) return makeResult(input, name, 'fail', 'Output has no after text to verify');

    const pinned = new Set(decisions.map((d) => d.id));
    const unpinned = rules.filter((r) => !pinned.has(r.decision_id));
    if (unpinned.length) {
      return makeResult(input, name, 'uncertain', `Rule cites a decision not pinned to this run: ${unpinned.map((r) => r.decision_key).join(', ')}`);
    }

    const matches: Array<Record<string, unknown>> = [];
    const negatedMentions: Array<Record<string, unknown>> = [];
    for (const part of assertedText(output)) {
      const text = normalizeText(part.text);
      for (const rule of rules) {
        for (const pattern of rule.patterns) {
          for (const m of text.matchAll(new RegExp(pattern, 'g'))) {
            const hit = { rule_id: rule.rule_id, decision_id: rule.decision_id, decision_key: rule.decision_key, decision_version: rule.decision_version, field: part.field, excerpt: m[0] };
            // Negation can sit before the whole match, or inside it just before its final words ("fee ... not collected revenue").
            const words = m[0].split(' ');
            const tailStart = m.index + m[0].length - words.slice(-2).join(' ').length;
            if (NEGATED.test(text.slice(0, m.index)) || (words.length > 2 && NEGATED.test(text.slice(0, tailStart)))) negatedMentions.push(hit);
            else matches.push({ ...hit, explanation: `${rule.label}. Conflicts with accepted decision ${rule.decision_key} v${rule.decision_version}`, proposed_repair: rule.proposed_repair });
          }
        }
      }
    }
    if (matches.length) {
      const cited = [...new Set(matches.map((m) => `${m.decision_key} (${m.decision_id})`))].join(', ');
      return makeResult(input, name, 'fail', `Forbidden claim conflicts with accepted decision ${cited}: "${matches[0]!.excerpt}"`, { matches, negated_mentions: negatedMentions });
    }
    return makeResult(input, name, 'pass', `No forbidden claim found against ${rules.map((r) => r.decision_key).join(', ')}`, {
      rules_checked: rules.map((r) => ({ rule_id: r.rule_id, decision_id: r.decision_id })), negated_mentions: negatedMentions,
    });
  };
}

const VAGUE_SOURCE = /^(?:n\/?a|none|tbd|todo|unknown|internal|internal knowledge|memory|common knowledge|general knowledge|agent|self|model|llm|see above|various)$/i;
/** Source keys of the deck of record (v8). Key names only. The agent is offered these and the slide itself. */
export const DECK_SOURCE_KEYS = ['a16z', 'app', 'aspen', 'axis', 'code', 'consolidation', 'deck', 'derived', 'founder', 'gymmc', 'hfa', 'hfa25', 'hfa_bench', 'hfa_global', 'ledger', 'memo', 'nfhs', 'owner', 'owner_plan', 'plan', 'sgb', 'sizing', 'vendors', 'vendors3', 'ycreview'];
export const DECK_SOURCE_PREFIXES = ['deck.json#slide-'];
const FIGURE = /(?:[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:%|percent\b|k\b|m\b|million\b|billion\b|members?\b|locations?\b|customers?\b|users?\b|athletes?\b|gyms?\b|months?\b|years?\b|x\b))/gi;

export function createClaimsSourcedEvaluator(): Evaluator {
  const name = 'det.milo_claims';
  return async (input) => {
    const { check, output, decisions } = input;
    if (!nonEmptyString(output.after)) return makeResult(input, name, 'fail', 'Output has no after text to verify');
    if (!Array.isArray(output.claims) || output.claims.length === 0) return makeResult(input, name, 'fail', 'Output makes assertions with no sourced claims');

    const prefixes = (Array.isArray(check.spec.allowed_source_prefixes) ? check.spec.allowed_source_prefixes : []) as string[];
    const allowedKeys = new Set((Array.isArray(check.spec.allowed_sources) ? check.spec.allowed_sources : []) as string[]);
    const decisionBySource = new Map(decisions.map((d) => [d.source_uri, d]));
    const failures: string[] = [];
    const doubts: string[] = [];
    const resolved: Array<Record<string, unknown>> = [];

    output.claims.forEach((claim, i) => {
      if (!isRecord(claim) || !nonEmptyString(claim.text)) { failures.push(`claim ${i} has no text`); return; }
      if (!nonEmptyString(claim.source)) { failures.push(`claim ${i} has no source`); return; }
      const source = claim.source.trim();
      if (allowedKeys.has(source)) { resolved.push({ claim: i, source, allowed_key: true }); return; }
      if (VAGUE_SOURCE.test(source)) { failures.push(`claim ${i} source "${source}" is not a real source`); return; }
      const decision = decisionBySource.get(source) ?? decisionBySource.get(source.split('#')[0]!);
      if (decision) {
        if (decision.source_historical && !/\bhistorical\b/i.test(`${claim.text} ${source}`)) {
          failures.push(`claim ${i} relies on a historical source without labeling it historical`);
          return;
        }
        resolved.push({ claim: i, source, decision_id: decision.id, decision_key: decision.decision_key });
      } else if (prefixes.some((p) => source.startsWith(p))) {
        resolved.push({ claim: i, source, allowed_prefix: true });
      } else {
        doubts.push(`claim ${i} source "${source}" is not a pinned or allowed source`);
      }
    });

    // A figure on the slide with no claim behind it is an unsourced claim.
    const claimsText = normalizeText(output.claims.filter(isRecord).map((c) => String(c.text ?? '')).join(' \n '));
    const figures = [...normalizeText(output.after).matchAll(FIGURE)].map((m) => m[0]);
    const uncovered = [...new Set(figures)].filter((f) => !claimsText.includes(f));
    if (uncovered.length) failures.push(`after states ${uncovered.join(', ')} with no sourced claim`);

    const payload = { resolved, failures, doubts, figures_checked: figures.length };
    if (failures.length) return makeResult(input, name, 'fail', failures.join('; '), payload);
    if (doubts.length) return makeResult(input, name, 'uncertain', doubts.join('; '), payload);
    return makeResult(input, name, 'pass', `${resolved.length} claim(s) resolve to pinned or allowed sources`, payload);
  };
}
