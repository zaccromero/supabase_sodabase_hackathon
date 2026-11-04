/**
 * Root cause of each open Sodabase Issue from the scan of 4 Nov 2026, from direct counts on the hosted mirror and
 * gym-nyc's own definitions (read-only). Only legitimate states are marked expected, with this reason recorded on the
 * Issue. A real defect stays open until it is fixed.
 */
export interface TriageEntry {
  issue_id: string;
  table: string;
  failing: number;
  classification: 'wrong_rule' | 'legitimate_state' | 'real_defect';
  root_cause: string;
  reason: string;
}

export const TRIAGE: TriageEntry[] = [
  {
    issue_id: '5e456ed4-aeb7-4909-a0a7-d6ccdabac8e6', table: 'gym.members', failing: 143, classification: 'wrong_rule',
    root_cause: 'The rules compare joined_at to membership end dates, but joined_at is EZFacility client DateCreated, not a membership start (gym-nyc docs/audits/ezfacility-membership-movement-key-authority.md:119). Of 143: 67 are the same NY day, a timestamp against a date at midnight. 68 are client records created in the 2024 migration window (15,079 of 35,543 members were created before 2024-10-15). 6 are records created after the membership end. 2 are real bad dates.',
    reason: 'joined_at is client DateCreated, not a membership start, so it can legitimately follow a membership end. 141 of 143 are explained that way. The other 2 are real bad 1980 expiration dates in the source (both Expired, neither in the canonical count). They are found by a direct count, because check_rule cannot express a date floor, and they remain open at the source.',
  },
  {
    issue_id: 'a0916704-dd17-4cd7-a6e8-808176ea4f8f', table: 'gym.finance_snapshots', failing: 28, classification: 'wrong_rule',
    root_cause: "All 28 rows have location_id 'all', the all-locations rollup. gym-nyc packages/db/schema.ts:890 documents 'no FK because of all'. There is no broken reference.",
    reason: "All 28 rows are the 'all' rollup, which has no row in locations by design (gym-nyc schema.ts:890). A separate rule checks location_id is 'all' or a real location, and it passes.",
  },
  {
    issue_id: '6ac59cf6-da38-4ed3-a83a-db79b026b1ff', table: 'gym.ezf_active_memberships', failing: 1, classification: 'legitimate_state',
    root_cause: 'One client holds two active memberships: one MATCHED_INDIVIDUAL and one MULTIPLE_ACTIVE_MEMBERSHIPS_ONE_CLIENT, the class that exists for this case. The real key is (location_id, source_membership_key), which has no duplicates. The canonical count is unaffected.',
    reason: 'One client with two active memberships, classified as gym.active_individual_definition requires, so counted once. The real key source_membership_key is unique, checked by a separate rule that passes.',
  },
  {
    issue_id: '33917cef-7044-4f18-aab3-214560a02c9a', table: 'cm.decisions', failing: 6, classification: 'real_defect',
    root_cause: "tools/import-approved.ts writes the owner's earlier approval time (21:39:16Z) into accepted_at on rows it inserts later (22:14:44Z), so one column holds two different events. Fix proposed in docs/migration-requests/005_decision_owner_approved_at.sql. Left open until applied.",
    reason: 'Not marked expected. Real defect in our own import; open until migration 005 is applied.',
  },
];
