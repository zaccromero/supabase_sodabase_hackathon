/**
 * Integrity rules for check_rule. Sodabase checks data integrity. It is not a judge of conversations or of whether an
 * agent followed a decision; that is the evaluators' job, and nothing here can pass or block a run.
 *
 * Rules were read against gym-nyc's definitions (read-only): packages/db/schema.ts, migration
 * 0007_active_member_owner_projection.sql, apps/web/lib/db/queries/owner-membership.ts and
 * docs/technical/finance-measures.md. They are always run with persist: false.
 */
export interface IntegrityRule {
  id: string;
  dataset: string;
  rule: string;
  /** exploratory results are recorded but never reported as a data problem until the count is validated. */
  status: 'active' | 'exploratory';
  basis: string;
}

export const INTEGRITY_RULES: IntegrityRule[] = [
  { id: 'membership-bridge-class-domain', dataset: 'gym.ezf_active_memberships', status: 'active', basis: 'CHECK am_bridge_class',
    rule: 'bridge_class must be one of MATCHED_INDIVIDUAL, EXCLUDED_INDEPENDENT_TRAINING_MEMBER, EXCLUDED_INDEPENDENT_TRAINER, EXCLUDED_CORPORATE, EXCLUDED_EMPLOYEE, EXCLUDED_NON_MEMBER, EXCLUDED_HOTEL or MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT.' },
  { id: 'membership-source-key-unique', dataset: 'gym.ezf_active_memberships', status: 'active', basis: 'unique (location_id, source_membership_key). This is the real key; a repeated membership number is legitimate.',
    rule: 'Each combination of location_id and source_membership_key must be unique.' },
  { id: 'finance-location-known-or-all', dataset: 'gym.finance_snapshots', status: 'active', basis: "schema.ts: location_id has no FK because of the 'all' rollup. Keeps a real broken reference visible.",
    rule: "location_id must be 'all' or one of lex, bk, east3, mul." },
  { id: 'decision-version-unique', dataset: 'cm.decisions', status: 'active', basis: '001_core.sql unique (decision_key, version)',
    rule: 'Each combination of decision_key and version must be unique.' },
  { id: 'evaluation-verdict-domain', dataset: 'cm.evaluations', status: 'active', basis: '001_core.sql evaluations verdict check',
    rule: 'verdict must be one of pass, fail or uncertain.' },
  { id: 'run-memory-mode', dataset: 'cm.runs', status: 'active', basis: '001_core.sql runs memory_mode',
    rule: 'memory_mode must not be null.' },
];

/**
 * Tried live on 4 Nov 2026 and returned unsupported, because check_rule takes single-column rules and these are
 * conditional or cross-table. Not sent. Checked by direct count on the gym mirror instead, or enforced by a constraint:
 * - check-ins before joined_at: 0 of 92,317, so that count is validated. A provider finding about it stays exploratory.
 * - MATCHED_INDIVIDUAL with a null member_id: 0. More than one per client: 0 groups.
 * - complete runs with unexplained records or an unbalanced bridge: CHECK amsr_zero_unexplained_complete, amsr_bridge_balance.
 */

/**
 * Legitimate by gym-nyc's own definitions. Never written as a rule, and a provider finding that matches is recorded
 * with disposition expected_by_definition instead of being reported as a data problem.
 */
export const NEVER_FLAG: Array<{ id: string; matches: RegExp[]; why: string }> = [
  { id: 'future-billed-at', matches: [/\b(?:billed_at|date_?billed|payment_date)\b/i, /\b(?:future|forward|ahead|after (?:now|today)|later than|not yet|scheduled)\b/i],
    why: 'EZFacility schedules future DateBilled for prepaid PIF; apps/web/lib/finance-window.ts and docs/technical/finance-measures.md' },
  { id: 'null-fee', matches: [/\b(?:monthly_fee_cents_real|fee_cents|fee_unknown(?:_count)?|fees?)\b/i, /\b(?:null|nulls|missing|empty|blank|unknown|not null|required|absent)\b/i],
    why: 'Null until fees sync or when a member has no invoices, by design; packages/db/schema.ts. Unknown is never estimated.' },
  { id: 'identical-billed-groups', matches: [/\bbilled_items\b/i, /\bduplicat/i],
    why: 'Same invoice, type, date and amount groups are legitimate; uniqueness is on ezf_billed_item_uid; docs/technical/finance-measures.md' },
  // Validated by direct count on the gym mirror, 4 Nov 2026 (mirror of 22:15 UTC). Rules above keep the real breaks visible.
  { id: 'finance-all-rollup', matches: [/\bfinance_snapshots\b/i, /\blocation_id\b/i, /\b(?:references?|exist)\b/i],
    why: "All 28 failing rows have location_id 'all', the rollup row; schema.ts documents no FK because of it." },
  { id: 'repeat-membership-number', matches: [/\bezf_active_memberships\b/i, /\bezf_membership_number\b/i, /\b(?:unique|duplicate)/i],
    why: 'The one repeated group is one MATCHED_INDIVIDUAL plus one MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT, as the definition intends. The key is source_membership_key.' },
  { id: 'sparse-by-design', matches: [/\b(?:finance_snapshots|checkin_sync_runs|members|decisions)\b/i, /\b(?:flagged|error_code|churned_at|supersedes_id)\b/i, /\bunused\b/i],
    why: 'Set only when something happened: a flag, a failed run, a churn, a superseded decision. churned_at is null on 34,330 of 35,543 members against a canonical count of 1,838, which is why churned_at IS NULL is not the definition.' },
  { id: 'negative-price', matches: [/\bprice_cents\b/i, /\bnegative\b/i],
    why: 'Negative price is a refund or void; packages/db/schema.ts' },
];

const EXPLORATORY: RegExp[][] = [[/\bcheck.?ins?\b|\bchecked_in_at\b/i, /\bjoined_at\b|\bbefore (?:the )?(?:member|join)/i]];

export type Disposition = 'actionable' | 'expected_by_definition' | 'exploratory';

export function classifyProblem(text: string): { disposition: Disposition; never_flag_id?: string } {
  for (const n of NEVER_FLAG) if (n.matches.every((m) => m.test(text))) return { disposition: 'expected_by_definition', never_flag_id: n.id };
  if (EXPLORATORY.some((all) => all.every((m) => m.test(text)))) return { disposition: 'exploratory' };
  return { disposition: 'actionable' };
}

/** Throws if a rule would flag something gym-nyc defines as legitimate. Applied to every rule before it is sent. */
export function assertRuleAllowed(rule: Pick<IntegrityRule, 'id' | 'rule'>): void {
  const hit = NEVER_FLAG.find((n) => n.matches.every((m) => m.test(rule.rule)));
  if (hit) throw new Error(`RULE_FLAGS_LEGITIMATE_DATA: ${rule.id} matches ${hit.id}`);
}
