import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/contract/hash';
import type { CheckSpec, EvaluationBinding, EvaluationResult, PinnedDecision } from '../src/contract/types';
import {
  checksFor, createCriticEvaluator, createRegistry, createStoredRegistry, frozenChecksHash, guarded, recordEvaluation, selectTransport,
  type CriticTransport, type GymSource,
} from '../src/evaluators/index';

const statements: Record<string, string> = {
  'gym.active_individual_definition': 'Count active individual members as one client-backed MATCHED_INDIVIDUAL row from the latest complete official EZFacility Memberships By Status projection. Do not substitute churned_at IS NULL.',
  'gym.freshness_completeness': 'Report the actual source report date. Missing or incomplete projections produce unknown counts, never fabricated zero counts.',
  'milo.gym_nyc_partner': "Gym NYC is a partner, not the founder's gym; equity ownership is unconfirmed.",
  'milo.fee_not_collected': 'The Gym NYC operations fee is founder-reported and conditional. Do not describe it as collected revenue.',
  'milo.alpha_not_usage': 'Controlled alpha scope is not proof of enrollment, usage, deployment, or certification. Enrollment is unknown, not zero.',
  'milo.current_positioning': 'Milo is the operating system for athletic life. Organization agents are being built; do not describe unshipped agents as live.',
};
const decision = (decision_key: string, i: number): PinnedDecision => ({
  id: `00000000-0000-4000-8000-00000000000${i}`, decision_key, version: 1, statement: statements[decision_key]!, source_uri: `docs/sources/${decision_key}.md`, source_historical: false,
});
const DECISIONS = Object.keys(statements).map(decision);
const pinned = (key: string) => DECISIONS.find((d) => d.decision_key === key)!;

const CANONICAL_SQL = `
  -- active individual members
  select m.location_id, count(*)::int as active_individual_members
  from gym.ezf_active_memberships m
  join (select distinct on (location_id) location_id, status from gym.ezf_active_membership_sync_runs order by location_id, started_at desc) r
    on r.location_id = m.location_id and r.status = 'complete'
  where m.bridge_class = 'MATCHED_INDIVIDUAL'
  group by m.location_id`;
const gymBody = (over: Record<string, unknown> = {}) => ({
  answer: [{ location_id: 'lex', active_individual_members: 1200 }],
  definition: 'MATCHED_INDIVIDUAL, latest complete projection',
  data_as_of: '2026-11-03', data_age_days: 1, sql: CANONICAL_SQL, ...over,
});
const miloBody = (after: string, over: Record<string, unknown> = {}) => ({
  slide_id: '09', before: "Gym NYC is the founder's own gym.", after, claims: [{ text: after, source: pinned('milo.gym_nyc_partner').source_uri }], ...over,
});

const bindingFor = (output: Record<string, unknown>): EvaluationBinding => ({
  run_id: 'r', attempt_id: 'a', output_id: 'o', contract_id: 'c', output_sha256: sha256(output), contract_sha256: 'contract',
});
const checkFor = (profile: Parameters<typeof checksFor>[0], id: string) => checksFor(profile, DECISIONS).find((c) => c.check_id === id)!;
const source = (dates: Record<string, string>, counts?: Record<string, number>): GymSource => ({
  dataAsOf: async () => dates, ...(counts ? { canonicalCounts: async () => counts } : {}),
});
const NOW = () => new Date('2026-11-04T20:00:00Z');
function run(profile: Parameters<typeof checksFor>[0], id: string, output: Record<string, unknown>, deps: Parameters<typeof createRegistry>[0] = {}) {
  return createRegistry({ now: NOW, ...deps })[id]!({ binding: bindingFor(output), check: checkFor(profile, id), output, decisions: DECISIONS });
}

describe('checksFor', () => {
  it('binds gym and milo checks to the accepted decision keys', () => {
    const gym = checksFor('gym_operator', DECISIONS);
    expect(gym.find((c) => c.check_id === 'gym.canonical_definition')!.decision_id).toBe(pinned('gym.active_individual_definition').id);
    expect(gym.find((c) => c.check_id === 'gym.data_age_reported')!.decision_id).toBe(pinned('gym.freshness_completeness').id);
    const milo = checksFor('milo_pitch', DECISIONS);
    const rules = milo.find((c) => c.check_id === 'milo.no_forbidden_claim')!.spec.rules as Array<{ decision_key: string; decision_id: string }>;
    expect(rules.map((r) => r.decision_key).sort()).toEqual(['milo.alpha_not_usage', 'milo.current_positioning', 'milo.fee_not_collected', 'milo.gym_nyc_partner']);
    for (const r of rules) expect(r.decision_id).toBe(pinned(r.decision_key).id);
    expect(milo.find((c) => c.check_id === 'critic.meaning')!.decision_id).toBe(pinned('milo.gym_nyc_partner').id);
  });

  it('keeps every deterministic check required when decisions are absent', () => {
    for (const profile of ['gym_operator', 'milo_pitch', 'drift_reviewer'] as const) {
      const checks = checksFor(profile, []);
      expect(checks.length).toBeGreaterThan(0);
      expect(checks.every((c) => c.kind === 'deterministic' && c.required && c.requires_evidence)).toBe(true);
    }
  });

  it('has an evaluator for every check of every profile, and each spec survives a JSON round trip', () => {
    const registry = createRegistry();
    for (const profile of ['gym_operator', 'milo_pitch', 'drift_reviewer'] as const) {
      for (const c of checksFor(profile, DECISIONS)) {
        expect(registry[c.check_id]).toBeTypeOf('function');
        expect(JSON.parse(JSON.stringify(c.spec))).toEqual(c.spec);
      }
    }
  });

  it('does not let a decision with a similar statement but another key activate a rule', () => {
    const lookalike = { ...pinned('milo.gym_nyc_partner'), decision_key: 'milo.old_gym_wording', statement: "Gym NYC is the founder's own gym" };
    expect(checksFor('milo_pitch', [lookalike]).find((c) => c.check_id === 'milo.no_forbidden_claim')!.spec.rules).toEqual([]);
  });
});

describe('gym.canonical_definition', () => {
  const id = 'gym.canonical_definition';
  it('passes the canonical SQL', async () => {
    expect((await run('gym_operator', id, gymBody())).verdict).toBe('pass');
  });
  it('passes the exists form member-contract.ts itself uses', async () => {
    const sql = `select m.location_id, count(*) n from gym.ezf_active_memberships m where m.bridge_class = 'MATCHED_INDIVIDUAL'
      and exists (select 1 from gym.ezf_active_membership_sync_runs r where r.location_id = m.location_id and r.status = 'complete') group by 1`;
    expect((await run('gym_operator', id, gymBody({ sql }))).verdict).toBe('pass');
  });
  it('fails churned_at IS NULL and says so', async () => {
    const r = await run('gym_operator', id, gymBody({ sql: `select location_id, count(*) from members where churned_at is null group by 1` }));
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/churned_at IS NULL/);
  });
  it('cannot be satisfied by a comment or a string literal', async () => {
    const commented = `select count(*) from members where churned_at is null -- from gym.ezf_active_memberships where bridge_class = 'MATCHED_INDIVIDUAL'
      /* join gym.ezf_active_membership_sync_runs on status = 'complete' */`;
    const literal = `select 'from gym.ezf_active_memberships where bridge_class = ''MATCHED_INDIVIDUAL'' and status = ''complete''' as x, count(*) from members`;
    expect((await run('gym_operator', id, gymBody({ sql: commented }))).verdict).toBe('fail');
    expect((await run('gym_operator', id, gymBody({ sql: literal }))).verdict).toBe('fail');
  });
  it('fails a wrong class, an inverted class, and no complete run', async () => {
    const swap = (from: string, to: string) => run('gym_operator', id, gymBody({ sql: CANONICAL_SQL.replace(from, to) }));
    expect((await swap(`= 'MATCHED_INDIVIDUAL'`, `= 'EXCLUDED_CORPORATE'`)).verdict).toBe('fail');
    expect((await swap(`= 'MATCHED_INDIVIDUAL'`, `<> 'MATCHED_INDIVIDUAL'`)).verdict).toBe('fail');
    expect((await swap(`r.status = 'complete'`, `r.status = 'failed'`)).verdict).toBe('fail');
  });
  it('routes shapes it cannot vouch for to uncertain', async () => {
    const widen = await run('gym_operator', id, gymBody({ sql: CANONICAL_SQL.replace(`group by`, `or m.bridge_class = 'EXCLUDED_CORPORATE' group by`) }));
    expect(widen.verdict).toBe('uncertain');
    const noLatest = await run('gym_operator', id, gymBody({ sql: `select count(*) from gym.ezf_active_memberships m join gym.ezf_active_membership_sync_runs r on r.location_id = m.location_id where m.bridge_class = 'MATCHED_INDIVIDUAL' and r.status = 'complete'` }));
    expect(noLatest.verdict).toBe('uncertain');
  });
  it('fails a correct-looking query whose answer differs from the independent recount', async () => {
    const r = await run('gym_operator', id, gymBody(), { gymSource: source({ lex: '2026-11-03' }, { lex: 999 }) });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/independent canonical recount/);
    expect((await run('gym_operator', id, gymBody(), { gymSource: source({ lex: '2026-11-03' }, { lex: 1200 }) })).verdict).toBe('pass');
  });
});

describe('gym.data_age_reported', () => {
  const id = 'gym.data_age_reported';
  const lex = source({ lex: '2026-11-03' });
  it('passes when data_as_of and age match the source', async () => {
    expect((await run('gym_operator', id, gymBody(), { gymSource: lex })).verdict).toBe('pass');
  });
  it('fails a data_as_of the source does not support, or a wrong age', async () => {
    expect((await run('gym_operator', id, gymBody({ data_as_of: '2026-11-04' }), { gymSource: lex })).verdict).toBe('fail');
    expect((await run('gym_operator', id, gymBody({ data_age_days: 30 }), { gymSource: lex })).verdict).toBe('fail');
    expect((await run('gym_operator', id, gymBody({ data_as_of: undefined }), { gymSource: lex })).verdict).toBe('fail');
  });
  it('reports a multi-location answer as fresh as its oldest location', async () => {
    const body = gymBody({ answer: [{ location_id: 'lex', active_individual_members: 1 }, { location_id: 'bk', active_individual_members: 2 }] });
    const dates = source({ lex: '2026-11-03', bk: '2026-11-01' });
    expect((await run('gym_operator', id, body, { gymSource: dates })).verdict).toBe('fail');
    expect((await run('gym_operator', id, { ...body, data_as_of: '2026-11-01', data_age_days: 3 }, { gymSource: dates })).verdict).toBe('pass');
  });
  it('fails a fabricated zero for a location with no complete projection, and accepts unknown', async () => {
    const zero = gymBody({ answer: [{ location_id: 'lex', active_individual_members: 1 }, { location_id: 'mul', active_individual_members: 0 }] });
    expect((await run('gym_operator', id, zero, { gymSource: lex })).verdict).toBe('fail');
    const unknown = gymBody({ answer: [{ location_id: 'lex', active_individual_members: 1 }, { location_id: 'mul', active_individual_members: null }] });
    expect((await run('gym_operator', id, unknown, { gymSource: lex })).verdict).toBe('pass');
  });
  it('is uncertain, never a pass, with no independent source', async () => {
    expect((await run('gym_operator', id, gymBody())).verdict).toBe('uncertain');
    const broken: GymSource = { dataAsOf: async () => { throw new Error('down'); } };
    expect((await run('gym_operator', id, gymBody(), { gymSource: broken })).verdict).toBe('uncertain');
  });
});

describe('milo.no_forbidden_claim', () => {
  const id = 'milo.no_forbidden_claim';
  const verdict = async (after: string) => run('milo_pitch', id, miloBody(after));
  it.each([
    ["Gym NYC is the founder's own gym.", 'milo.gym_nyc_partner'],
    ['Gym NYC is the founder’s​ own four-location gym.', 'milo.gym_nyc_partner'],
    ['Milo runs on OUR GYM, Gym NYC.', 'milo.gym_nyc_partner'],
    ['The founder owns Gym NYC outright.', 'milo.gym_nyc_partner'],
    ['Not only the founder\'s gym, it is also the first customer.', 'milo.gym_nyc_partner'],
    ['The operations fee is collected revenue.', 'milo.fee_not_collected'],
    ['The Gym NYC fee has been collected since June.', 'milo.fee_not_collected'],
    ['The fee, not small at all, is collected revenue.', 'milo.fee_not_collected'],
    ['The alpha proves usage across the gym.', 'milo.alpha_not_usage'],
    ['Milo is live at 4 alpha sites.', 'milo.alpha_not_usage'],
    ['Enrollment is zero today.', 'milo.alpha_not_usage'],
    ['Organization agents are live for operators.', 'milo.current_positioning'],
  ])('fails %s and cites its decision', async (after, key) => {
    const r = await verdict(after);
    expect(r.verdict).toBe('fail');
    expect(r.reason).toContain(key);
    expect(r.reason).toContain(pinned(key).id);
    const matches = r.evidence!.payload.matches as Array<Record<string, unknown>>;
    expect(matches[0]).toMatchObject({ decision_key: key, decision_id: pinned(key).id });
    expect(matches[0]!.proposed_repair).toBeTruthy();
  });
  it.each([
    "Gym NYC is a partner, not the founder's gym.",
    'The fee is founder-reported and conditional, not collected revenue.',
    'Organization agents for athletics operators are being built.',
    'Enrollment is unknown, not zero.',
    'Milo is the operating system for athletic life.',
    'Gym NYC is our gym partner.',
  ])('passes %s', async (after) => {
    expect((await verdict(after)).verdict).toBe('pass');
  });
  it('ignores the old wording in before, which is what is being replaced', async () => {
    expect((await verdict('Gym NYC is a partner.')).verdict).toBe('pass');
  });
  it('also scans claim text', async () => {
    const r = await run('milo_pitch', id, miloBody('Gym NYC is a partner.', { claims: [{ text: "It is the founder's own gym", source: 'x' }] }));
    expect(r.verdict).toBe('fail');
  });
  it('is uncertain with no rules pinned, rather than passing on nothing', async () => {
    const output = miloBody('Anything at all');
    const check = checksFor('milo_pitch', []).find((c) => c.check_id === id)!;
    expect((await createRegistry()[id]!({ binding: bindingFor(output), check, output, decisions: [] })).verdict).toBe('uncertain');
  });
  it('is uncertain when a rule cites a decision not pinned to this run', async () => {
    const output = miloBody('Gym NYC is a partner.');
    const r = await createRegistry()[id]!({ binding: bindingFor(output), check: checkFor('milo_pitch', id), output, decisions: DECISIONS.slice(0, 2) });
    expect(r.verdict).toBe('uncertain');
  });
});

describe('milo.claims_sourced', () => {
  const id = 'milo.claims_sourced';
  const body = (claims: unknown, after = 'Gym NYC is a partner.') => ({ slide_id: '09', before: 'old', after, claims });
  it('passes a pinned source, a fragment of one, a deck key and the slide itself', async () => {
    const uri = pinned('milo.gym_nyc_partner').source_uri;
    for (const source of [uri, `${uri}#line-3`, 'memo', 'deck.json#slide-09']) {
      expect((await run('milo_pitch', id, body([{ text: 'Gym NYC is a partner.', source }]))).verdict).toBe('pass');
    }
  });
  it('fails no claims, an empty source and a vague source', async () => {
    expect((await run('milo_pitch', id, body([]))).verdict).toBe('fail');
    expect((await run('milo_pitch', id, body([{ text: 't', source: ' ' }]))).verdict).toBe('fail');
    expect((await run('milo_pitch', id, body([{ text: 't', source: 'common knowledge' }]))).verdict).toBe('fail');
  });
  it('sends an unknown but specific source to the founder', async () => {
    expect((await run('milo_pitch', id, body([{ text: 't', source: 'docs/other/file.md' }]))).verdict).toBe('uncertain');
  });
  it('fails a figure on the slide that no claim covers', async () => {
    const r = await run('milo_pitch', id, body([{ text: 'Gym NYC is a partner.', source: 'memo' }], 'Gym NYC is a partner with 4 locations.'));
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/4 locations/);
  });
  it('fails a historical source that is not labeled historical', async () => {
    const historical = { ...pinned('milo.gym_nyc_partner'), source_historical: true };
    const others = DECISIONS.filter((d) => d.id !== historical.id);
    const unlabeled = body([{ text: 'Gym NYC is a partner.', source: historical.source_uri }]);
    const decisions = [historical, ...others];
    const call = (output: Record<string, unknown>) => createRegistry()[id]!({ binding: bindingFor(output), check: checkFor('milo_pitch', id), output, decisions });
    expect((await call(unlabeled)).verdict).toBe('fail');
    expect((await call(body([{ text: 'Historical: Gym NYC is a partner.', source: historical.source_uri }]))).verdict).toBe('pass');
  });
});

describe('drift.findings_cited', () => {
  const id = 'drift.findings_cited';
  const finding = { decision_id: pinned('milo.gym_nyc_partner').id, excerpt: "the founder's own gym", explanation: 'Conflicts', proposed_repair: 'Describe as partner' };
  const reader = { targetOutputBody: async () => ({ after: "Gym NYC is the Founder’s own gym." }) };
  it('passes a finding whose excerpt is in the target, read independently', async () => {
    expect((await run('drift_reviewer', id, { target_output_id: 't', findings: [finding] }, reader)).verdict).toBe('pass');
  });
  it('fails an invented excerpt and an unpinned decision', async () => {
    expect((await run('drift_reviewer', id, { target_output_id: 't', findings: [{ ...finding, excerpt: 'never said this' }] }, reader)).verdict).toBe('fail');
    expect((await run('drift_reviewer', id, { target_output_id: 't', findings: [{ ...finding, decision_id: 'other' }] }, reader)).verdict).toBe('fail');
  });
  it('passes a clean review only if it covered every pinned decision', async () => {
    const all = DECISIONS.map((d) => ({ id: d.id }));
    expect((await run('drift_reviewer', id, { findings: [], decisions_reviewed: all }, reader)).verdict).toBe('pass');
    expect((await run('drift_reviewer', id, { findings: [], decisions_reviewed: all.slice(1) }, reader)).verdict).toBe('uncertain');
  });
});

describe('critic.meaning', () => {
  const id = 'critic.meaning';
  const output = miloBody("Gym NYC is the founder's own gym.");
  const double = (reply: string | Error, seen: string[] = []): CriticTransport => ({
    name: 'test_double',
    complete: async ({ user }) => { seen.push(user); if (reply instanceof Error) throw reply; return reply; },
  });
  const say = (v: object) => JSON.stringify({ excerpt: '', reason: 'r', ...v });
  const judge = (transport: CriticTransport | null, body: Record<string, unknown> = output) => run('milo_pitch', id, body, { transport });

  it('maps a confident verdict and records the transport in evidence', async () => {
    const pass = await judge(double(say({ verdict: 'honors', confidence: 0.95 })));
    expect(pass.verdict).toBe('pass');
    expect(pass.evidence!.payload).toMatchObject({ transport: 'test_double', model: 'claude-sonnet-5-5', decision_key: 'milo.gym_nyc_partner' });
    const fail = await judge(double(say({ verdict: 'violates', confidence: 0.95, excerpt: "the founder's own gym" })));
    expect(fail.verdict).toBe('fail');
  });
  it('returns uncertain for low confidence, unclear, bad output, a failed transport or no transport', async () => {
    expect((await judge(double(say({ verdict: 'honors', confidence: 0.4 })))).verdict).toBe('uncertain');
    expect((await judge(double(say({ verdict: 'violates', confidence: 0.3, excerpt: 'gym' })))).verdict).toBe('uncertain');
    expect((await judge(double(say({ verdict: 'unclear', confidence: 0.99 })))).verdict).toBe('uncertain');
    expect((await judge(double('not json'))).verdict).toBe('uncertain');
    expect((await judge(double(new Error('boom')))).verdict).toBe('uncertain');
    const none = await judge(null);
    expect(none.verdict).toBe('uncertain');
    expect(none.evidence!.payload.failure).toBe('NO_TRANSPORT');
  });
  it('does not trust a violation quoting text that is not in the output', async () => {
    expect((await judge(double(say({ verdict: 'violates', confidence: 0.99, excerpt: 'made up words' })))).verdict).toBe('uncertain');
  });
  it('sends only the decision and what the output asserts, and never changes the check', async () => {
    const seen: string[] = [];
    const check = checkFor('milo_pitch', id);
    const frozen = JSON.stringify(check);
    const body = miloBody('Gym NYC is a partner.', { before: 'OLD WORDING HERE' });
    await createCriticEvaluator({ transport: double(say({ verdict: 'honors', confidence: 0.9 }), seen) })({ binding: bindingFor(body), check, output: body, decisions: DECISIONS });
    expect(seen[0]).toContain(statements['milo.gym_nyc_partner']);
    expect(seen[0]).not.toContain(statements['milo.fee_not_collected']);
    expect(seen[0]).not.toContain('OLD WORDING HERE');
    expect(JSON.stringify(check)).toBe(frozen);
  });
  it('is uncertain when the named decision is not pinned', async () => {
    const r = await createRegistry({ transport: double(say({ verdict: 'honors', confidence: 1 })) })[id]!({ binding: bindingFor(output), check: checkFor('milo_pitch', id), output, decisions: [] });
    expect(r.verdict).toBe('uncertain');
  });
  it('selects the transport from the environment', () => {
    expect(selectTransport({ MODEL_TRANSPORT: 'cli', ANTHROPIC_API_KEY: 'x' })!.name).toBe('cli');
    expect(selectTransport({ ANTHROPIC_API_KEY: 'x' })!.name).toBe('api');
    expect(selectTransport({})).toBeNull();
  });
});

describe('binding guard', () => {
  const fake = async (): Promise<EvaluationResult> => ({ check_id: 'x', verdict: 'pass', reason: 'r', evaluator: 'e', evaluator_version: '1' });
  const check: CheckSpec = { check_id: 'x', kind: 'deterministic', required: true, requires_evidence: true, spec: {} };
  it('fails an output that is not the bound one, without running the evaluator', async () => {
    const r = await guarded(fake, 'e')({ binding: bindingFor({ a: 1 }), check, output: { a: 2 }, decisions: [] });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/BINDING_OUTPUT_HASH_MISMATCH/);
  });
  it('fails an incomplete binding', async () => {
    const r = await guarded(fake, 'e')({ binding: { ...bindingFor({ a: 1 }), contract_id: '' }, check, output: { a: 1 }, decisions: [] });
    expect(r.reason).toMatch(/BINDING_INCOMPLETE/);
  });
  it('turns an evaluator crash into uncertain', async () => {
    const r = await guarded(async () => { throw new Error('secret detail'); }, 'e')({ binding: bindingFor({ a: 1 }), check, output: { a: 1 }, decisions: [] });
    expect(r.verdict).toBe('uncertain');
    expect(r.reason).not.toContain('secret detail');
  });
});

describe('through the real gate', () => {
  const sql = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
  let db: PGlite;
  const one = async <T = any>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows[0]!;
  const as = async <T>(role: string, fn: () => Promise<T>) => {
    await db.exec(`set role ${role}`);
    try { return await fn(); } finally { await db.exec('reset role'); }
  };
  /** Same shape as the runner's Db: every statement runs under the named role. */
  const roleDb = { withRole: <T>(role: string, fn: (tx: { query: <R>(s: string, p?: unknown[]) => Promise<R[]> }) => Promise<T>) => as(role, () => fn({ query: async <R>(s: string, p: unknown[] = []) => (await db.query<R>(s, p)).rows })) };

  async function seedDecisions(keys: string[]): Promise<PinnedDecision[]> {
    const out: PinnedDecision[] = [];
    for (const key of keys) {
      const uri = `docs/sources/${key}.md`;
      const s = await one<{ id: string }>(`insert into cm.sources (kind, uri, title) values ('owner_note',$1,$1) returning id`, [uri]);
      const d = await one<{ id: string }>(
        `insert into cm.decisions (decision_key, statement, scope, status, source_id, proposed_by, accepted_by, accepted_at)
         values ($1,$2,'{test}','accepted',$3,'test fixture','test fixture',now()) returning id`, [key, statements[key], s.id]);
      out.push({ id: d.id, decision_key: key, version: 1, statement: statements[key]!, source_uri: uri, source_historical: false });
    }
    return out;
  }
  async function seedRun(profile: 'gym_operator' | 'milo_pitch', decisions: PinnedDecision[]) {
    const run = await one<{ id: string }>(`insert into cm.runs (profile, task, status) values ($1,'test fixture','running') returning id`, [profile]);
    for (const d of decisions) await db.query(`insert into cm.run_decisions (run_id, decision_id) values ($1,$2)`, [run.id, d.id]);
    const checks = checksFor(profile, decisions).filter((c) => c.kind === 'deterministic');
    const contract = await one<{ id: string }>(`insert into cm.check_contracts (run_id) values ($1) returning id`, [run.id]);
    for (const c of checks) {
      await db.query(`insert into cm.contract_checks (contract_id, check_id, kind, required, requires_evidence, decision_id, spec) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [contract.id, c.check_id, c.kind, c.required, c.requires_evidence, c.decision_id ?? null, JSON.stringify(c.spec)]);
    }
    const contractSha = frozenChecksHash(checks);
    await db.query(`update cm.check_contracts set contract_sha256=$1, frozen_at=now() where id=$2`, [contractSha, contract.id]);
    return { runId: run.id, contractId: contract.id, contractSha, checks };
  }
  async function attempt(s: Awaited<ReturnType<typeof seedRun>>, no: number, kind: 'initial' | 'repair', body: Record<string, unknown>) {
    const a = await one<{ id: string }>(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,$3,$4) returning id`, [s.runId, s.contractId, no, kind]);
    const hash = sha256(body);
    const o = await as('agent_worker', () => one<{ id: string }>(`insert into cm.outputs (attempt_id, body, output_sha256) values ($1,$2::jsonb,$3) returning id`, [a.id, JSON.stringify(body), hash]));
    await as('agent_worker', () => db.query(`insert into cm.evidence (output_id, kind, payload, created_by) values ($1,'handler_result','{"note":"test fixture"}','agent_worker')`, [o.id]));
    const binding: EvaluationBinding = { run_id: s.runId, attempt_id: a.id, output_id: o.id, contract_id: s.contractId, output_sha256: hash, contract_sha256: s.contractSha };
    return { binding, body };
  }
  async function evaluateAll(s: Awaited<ReturnType<typeof seedRun>>, a: Awaited<ReturnType<typeof attempt>>, decisions: PinnedDecision[], deps: { transport?: CriticTransport | null } = {}) {
    const registry = createStoredRegistry(roleDb, { transport: null, now: NOW, ...deps });
    const results: EvaluationResult[] = [];
    for (const check of s.checks) {
      const result = await registry[check.check_id]!({ binding: a.binding, check, output: a.body, decisions });
      await as('evaluator_service', () => recordEvaluation({ query: (t, p) => db.query(t, p) as any }, a.binding, result));
      results.push(result);
    }
    return results;
  }
  const complete = (runId: string) => as('gate_service', () => one<{ r: any }>(`select cm.request_completion($1) r`, [runId]));
  const addGymMirror = () => db.exec(`
    create schema gym;
    create table gym.ezf_active_membership_sync_runs (location_id text, status text, report_as_of date, started_at timestamptz);
    create table gym.ezf_active_memberships (location_id text, bridge_class text);
    insert into gym.ezf_active_membership_sync_runs values ('lex','complete','2026-11-03',now());
    insert into gym.ezf_active_memberships select 'lex','MATCHED_INDIVIDUAL' from generate_series(1,3);
    insert into gym.ezf_active_memberships values ('lex','EXCLUDED_CORPORATE');
    grant usage on schema gym to evaluator_service; grant select on all tables in schema gym to evaluator_service;`);

  beforeEach(async () => { db = new PGlite(); await db.exec(sql); });

  it('REJECTS self-evaluation: a worker holding the real binding fields cannot write its own pass', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner']);
    const s = await seedRun('milo_pitch', decisions);
    const body = miloBody("Gym NYC is the founder's own gym.", { claims: [{ text: 'x', source: decisions[0]!.source_uri }] });
    const { binding: b } = await attempt(s, 1, 'initial', body);
    const check = 'milo.no_forbidden_claim';

    // Every binding field is correct. The only thing wrong is who is writing.
    await expect(as('agent_worker', () => db.query(
      `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason)
       values ($1,$2,$3,$4,$5,$6,$7,'det.milo_forbidden','1','pass','I checked myself')`,
      [b.run_id, b.attempt_id, b.output_id, b.contract_id, check, b.output_sha256, b.contract_sha256]))).rejects.toThrow(/permission denied/);
    await expect(as('agent_worker', () => db.query(`select cm.request_completion($1)`, [b.run_id]))).rejects.toThrow(/permission denied/);
    await expect(as('agent_worker', () => db.query(`update cm.runs set status='completed' where id=$1`, [b.run_id]))).rejects.toThrow(/permission denied/);

    // Evidence the worker may write does not move the gate.
    const gate = await complete(b.run_id);
    expect(gate.r.verdict).toBe('blocked');
    expect(gate.r.missing.map((m: any) => m.reason)).toContain('NO_CURRENT_EVALUATION');
    expect((await one<{ n: number }>(`select count(*)::int n from cm.evaluations where run_id=$1`, [b.run_id])).n).toBe(0);
  });

  it('REJECTS self-evaluation at the evaluator when the editing agent is the evaluator', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner']);
    const s = await seedRun('milo_pitch', decisions);
    const a = await attempt(s, 1, 'initial', miloBody('Gym NYC is a partner.', { claims: [{ text: 'Gym NYC is a partner.', source: decisions[0]!.source_uri }] }));
    const registry = createStoredRegistry(roleDb, { transport: null, editingAgentId: 'evaluator_service' });
    const r = await registry['milo.no_forbidden_claim']!({ binding: a.binding, check: s.checks[0]!, output: a.body, decisions });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/SELF_EVALUATION/);
  });

  it('claims in the output cannot speak for the evaluator', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner']);
    const s = await seedRun('milo_pitch', decisions);
    const a = await attempt(s, 1, 'initial', miloBody("Gym NYC is the founder's own gym.", { evaluation: { verdict: 'pass' }, self_check: 'passed' }));
    const [forbidden] = await evaluateAll(s, a, decisions);
    expect(forbidden!.verdict).toBe('fail');
  });

  it('blocks a violation, cites the decision, and passes only after a repair; the earlier evaluation stays stale', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner', 'milo.fee_not_collected']);
    const s = await seedRun('milo_pitch', decisions);
    const src = decisions[0]!.source_uri;
    const bad = await attempt(s, 1, 'initial', miloBody("Gym NYC is the founder's own gym.", { claims: [{ text: 'x', source: src }] }));
    await evaluateAll(s, bad, decisions);
    const blocked = await complete(s.runId);
    expect(blocked.r.verdict).toBe('blocked');
    expect(blocked.r.missing[0]).toMatchObject({ check_id: 'milo.no_forbidden_claim', reason: 'FAILED' });

    const good = await attempt(s, 2, 'repair', miloBody('Gym NYC is a partner.', { claims: [{ text: 'Gym NYC is a partner.', source: src }] }));
    expect((await complete(s.runId)).r.missing.every((m: any) => m.reason === 'NO_CURRENT_EVALUATION')).toBe(true);
    const results = await evaluateAll(s, good, decisions);
    expect(results.map((r) => r.verdict)).toEqual(['pass', 'pass']);
    expect((await complete(s.runId)).r.verdict).toBe('completed');
  });

  it('the database rejects a stale binding even from evaluator_service', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner']);
    const s = await seedRun('milo_pitch', decisions);
    const a = await attempt(s, 1, 'initial', miloBody('Gym NYC is a partner.'));
    const [result] = await evaluateAll(s, a, decisions);
    const write = (b: EvaluationBinding) => as('evaluator_service', () => recordEvaluation({ query: (t, p) => db.query(t, p) as any }, b, result!));
    await expect(write({ ...a.binding, output_sha256: 'stale' })).rejects.toThrow(/BINDING_OUTPUT_HASH_MISMATCH/);
    await expect(write({ ...a.binding, contract_sha256: 'stale' })).rejects.toThrow(/BINDING_CONTRACT_HASH_MISMATCH/);
  });

  it('the stored registry refuses a check that is not in the frozen contract', async () => {
    const decisions = await seedDecisions(['milo.gym_nyc_partner']);
    const s = await seedRun('milo_pitch', decisions);
    const a = await attempt(s, 1, 'initial', miloBody('Gym NYC is a partner.'));
    const loosened = { ...s.checks[0]!, spec: { rules: [] } };
    const r = await createStoredRegistry(roleDb, { transport: null })['milo.no_forbidden_claim']!({ binding: a.binding, check: loosened, output: a.body, decisions });
    expect(r.verdict).toBe('fail');
    expect(r.reason).toMatch(/BINDING_UNKNOWN_CHECK/);
  });

  it('the stored registry recounts gym answers from the mirror, as evaluator_service', async () => {
    await addGymMirror();
    const decisions = await seedDecisions(['gym.active_individual_definition', 'gym.freshness_completeness']);
    const s = await seedRun('gym_operator', decisions);
    const honest = await attempt(s, 1, 'initial', gymBody({ answer: [{ location_id: 'lex', active_individual_members: 3 }] }));
    expect((await evaluateAll(s, honest, decisions)).map((r) => r.verdict)).toEqual(['pass', 'pass']);
    expect((await complete(s.runId)).r.verdict).toBe('completed');

    const s2 = await seedRun('gym_operator', decisions);
    const padded = await attempt(s2, 1, 'initial', gymBody({ answer: [{ location_id: 'lex', active_individual_members: 4 }] }));
    const [definition] = await evaluateAll(s2, padded, decisions);
    expect(definition!.verdict).toBe('fail');
    expect((await complete(s2.runId)).r.verdict).toBe('blocked');
  });
});
