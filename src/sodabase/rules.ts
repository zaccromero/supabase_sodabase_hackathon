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
  { id: 'membership-bridge-class-domain', dataset: 'gym.ezf_active_memberships', status: 'active', basis: 'CHECK ezf_active_memberships_bridge_class_check',
    rule: 'bridge_class must be one of MATCHED_INDIVIDUAL, EXCLUDED_INDEPENDENT_TRAINING_MEMBER, EXCLUDED_INDEPENDENT_TRAINER, EXCLUDED_CORPORATE, EXCLUDED_EMPLOYEE, EXCLUDED_NON_MEMBER, EXCLUDED_HOTEL or MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT.' },
  { id: 'matched-individual-client-backed', dataset: 'gym.ezf_active_memberships', status: 'active', basis: 'sync-ezfacility-active-memberships.ts throws MEMBER_IDENTITY_UNRESOLVED before a projection with an unmapped individual can complete',
    rule: 'Every row with bridge_class MATCHED_INDIVIDUAL must have a non-null member_id.' },
  { id: 'complete-run-nothing-unexplained', dataset: 'gym.ezf_active_membership_sync_runs', status: 'active', basis: 'CHECK ezf_active_membership_runs_zero_unexplained_complete_check',
    rule: "Every row with status complete must have unmapped_members = 0 and unexplained_records = 0." },
  { id: 'complete-run-bridge-balance', dataset: 'gym.ezf_active_membership_sync_runs', status: 'active', basis: 'CHECK ezf_active_membership_runs_bridge_balance_check',
    rule: 'Every row with status complete must have source_rows_total equal to active_individual_members + explained_exclusions + structural_differences.' },
  { id: 'complete-run-has-report-date', dataset: 'gym.ezf_active_membership_sync_runs', status: 'active', basis: 'owner-membership.ts treats a run with no report_as_of as PARTIAL',
    rule: 'Every row with status complete must have a non-null report_as_of and a non-null finished_at.' },
  { id: 'accepted-decision-provenance', dataset: 'cm.decisions', status: 'active', basis: '001_core.sql decisions_accepted check and source_id',
    rule: 'Every row with status accepted must have non-null accepted_by, accepted_at and source_id.' },
  { id: 'decision-version-unique', dataset: 'cm.decisions', status: 'active', basis: '001_core.sql unique (decision_key, version)',
    rule: 'Each combination of decision_key and version must be unique.' },
  { id: 'evaluation-verdict-domain', dataset: 'cm.evaluations', status: 'active', basis: '001_core.sql evaluations verdict check',
    rule: 'verdict must be one of pass, fail or uncertain and check_id must not be null.' },
  { id: 'run-memory-mode', dataset: 'cm.runs', status: 'active', basis: '001_core.sql runs memory_mode',
    rule: 'memory_mode must not be null.' },
  // Unvalidated: joined_at and checked_in_at both went through a tz repair (docs/runbooks/sp3-tz-repair.md), so a
  // nonzero count may not be an error. Stays exploratory until the count is validated.
  { id: 'checkin-before-joined', dataset: 'gym.checkins', status: 'exploratory', basis: 'Candidate only. No gym-nyc definition makes this an error yet.',
    rule: "How many check-ins have checked_in_at earlier than the joined_at of their member?" },
];

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
