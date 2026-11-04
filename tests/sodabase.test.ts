import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRuleAllowed, classifyProblem, INTEGRITY_RULES } from '../src/sodabase/rules';
import { insertQualityRows, pullFindings } from '../src/sodabase/pull';
import { sanitize } from '../src/sodabase/sanitize';
import { SodabaseClient, SODABASE_PROJECT_REF } from '../src/sodabase/client';
import { asJsonText, asLiveEnvelope, asStructured, SodabaseTestDouble } from './sodabase-test-double';

const migration = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
const NOW = () => new Date('2026-11-04T22:00:00.000Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'sodabase-receipts-'));

describe('integrity rules', () => {
  it('never flags future billed_at or null fees, as a rule or as a provider finding', () => {
    expect(() => assertRuleAllowed({ id: 'x', rule: 'billed_at must not be in the future' })).toThrow(/RULE_FLAGS_LEGITIMATE_DATA/);
    expect(() => assertRuleAllowed({ id: 'x', rule: 'monthly_fee_cents_real must not be null' })).toThrow(/RULE_FLAGS_LEGITIMATE_DATA/);
    expect(classifyProblem('billed_items 412 rows have billed_at in the future').disposition).toBe('expected_by_definition');
    expect(classifyProblem('members monthly_fee_cents_real is null on 90% of rows').disposition).toBe('expected_by_definition');
    expect(classifyProblem('billed_items has duplicate invoice groups').disposition).toBe('expected_by_definition');
    expect(classifyProblem('cm.decisions Unused column: supersedes_id: effectively unused').disposition).toBe('expected_by_definition');
  });
  it('keeps check-ins before joined_at exploratory', () => {
    expect(classifyProblem('checkins 31 rows have checked_in_at before joined_at').disposition).toBe('exploratory');
  });
  it('treats an unrelated problem as actionable', () => {
    expect(classifyProblem('ezf_active_memberships has unknown bridge_class values').disposition).toBe('actionable');
  });
  it('ships only rules that pass its own guard', () => {
    for (const r of INTEGRITY_RULES) expect(() => assertRuleAllowed(r)).not.toThrow();
    expect(new Set(INTEGRITY_RULES.map((r) => r.id)).size).toBe(INTEGRITY_RULES.length);
  });
});

describe('sanitize', () => {
  it('drops row-shaped keys, keeps counts, and scrubs strings', () => {
    const out = sanitize({
      rows: 12, records: [{ email: 'a@b.co' }], sample: [{ id: 1 }], query: 'select * from gym.members', problems: [{ title: 'Reach pat@example.com or 212-555-0100', count: 3 }],
      note: 'token sb_pat_abc123 Bearer xyz.123', when: '2026-11-04T22:00:00Z',
    }) as Record<string, any>;
    expect(out.rows).toBe(12);
    expect(out).not.toHaveProperty('records');
    expect(out).not.toHaveProperty('sample');
    expect(out).not.toHaveProperty('query');
    expect(out.problems[0].title).toBe('Reach [email removed] or [phone removed]');
    expect(out.problems[0].count).toBe(3);
    expect(JSON.stringify(out)).not.toMatch(/sb_pat_abc123|xyz\.123/);
    expect(out.when).toBe('2026-11-04T22:00:00Z');
    expect(sanitize('open https://supabase.com/authorize?state=abc&code=xyz now')).toBe('open https://supabase.com/authorize?[query string removed] now');
  });
});

describe('pullFindings with the test double', () => {
  let db: PGlite;
  const asEvaluator = { query: async (t: string, p?: unknown[]) => { await db.exec('set role evaluator_service'); try { return await db.query(t, p) as any; } finally { await db.exec('reset role'); } } };
  beforeEach(async () => { db = new PGlite(); await db.exec(migration); });

  const health = asStructured({
    tables: [
      { table: 'gym.members', verdict: 'trusted', problems: [] },
      { table: 'gym.ezf_active_memberships', verdict: 'untrusted', problems: [{ problem: 'unknown bridge_class values', count: 4, finding_id: 'f1', severity: 'high' }] },
      { table: 'billed_items', verdict: 'caveated', problems: [{ problem: 'billed_at in the future', count: 412, finding_id: 'f2' }] },
      { table: 'gym.checkins', verdict: 'caveated', problems: [{ problem: 'checked_in_at before joined_at', count: 31, finding_id: 'f3' }] },
    ],
  });

  it('writes quality_findings as evaluator_service and a dated receipt, with dispositions', async () => {
    const dir = tmp();
    const client = new SodabaseTestDouble({
      data_trust_health: health,
      list_inbox: asJsonText({ issues: [{ id: 'f1', table: 'gym.ezf_active_memberships', title: 'dup of f1' }, { id: 'i9', dataset: 'cm.runs', title: 'Freshness lag', severity: 'low' }] }),
      explain: asStructured({ root_cause: 'Mirror ran before the sync finished' }),
    });
    const result = await pullFindings(client, { db: asEvaluator, receiptsDir: dir, now: NOW });

    expect(result.counts).toMatchObject({ actionable: 2, expected_by_definition: 1, exploratory: 1, clean: 1, errors: 0 });
    expect(result.inserted).toBe(5);
    const stored = (await db.query<any>(`select provider_finding_id, table_name, verdict, finding_count, raw->>'disposition' d from cm.quality_findings order by provider_finding_id nulls first`)).rows;
    expect(stored.map((r) => r.provider_finding_id)).toEqual([null, 'f1', 'f2', 'f3', 'i9']);
    expect(stored.find((r) => r.provider_finding_id === 'f2')).toMatchObject({ d: 'expected_by_definition', finding_count: 412 });
    expect(stored.find((r) => r.provider_finding_id === 'f3')!.d).toBe('exploratory');
    expect(client.calls.filter((c) => c.tool === 'explain').map((c) => c.args.id)).toEqual(['i9']);

    expect(readdirSync(dir)).toEqual(['sodabase-2026-11-04T22-00-00Z.json']);
    const receipt = JSON.parse(readFileSync(result.receipt_path!, 'utf8'));
    expect(receipt.provenance).toBe('test_double');
    expect(receipt.scope).toMatch(/does not judge conversations/);
    expect(client.closed).toBe(true);
  });

  it('never lets row data reach the database or the receipt, even if a provider returned it', async () => {
    const dir = tmp();
    const leaky = asStructured({ tables: [{ table: 'gym.members', verdict: 'untrusted', problems: [{
      problem: 'Bad rows such as jane@example.com', count: 2, finding_id: 'f9', rows: [{ email: 'jane@example.com', phone: '212-555-0100' }], query: "select * from gym.members where email='jane@example.com'", sample: [{ name: 'Jane' }],
    }] }] });
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: leaky }), { db: asEvaluator, receiptsDir: dir, now: NOW });
    const everything = readFileSync(result.receipt_path!, 'utf8') + JSON.stringify((await db.query('select * from cm.quality_findings')).rows);
    expect(everything).not.toMatch(/jane@example\.com|212-555-0100|select \* from|Jane/);
    expect(result.rows[0]!.finding_count).toBe(2);
  });

  it('invents nothing from prose or from an unknown shape', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseTestDouble({
      data_trust_health: { content: [{ type: 'text', text: 'All tables trusted, score 100' }] },
      list_inbox: asStructured({ surprise: true }),
    }), { db: asEvaluator, receiptsDir: dir, now: NOW });
    expect(result.rows).toEqual([]);
    expect(result.counts.unparsed).toBe(2);
    expect((await db.query<any>('select count(*)::int n from cm.quality_findings')).rows[0].n).toBe(0);
    const receipt = JSON.parse(readFileSync(result.receipt_path!, 'utf8'));
    expect(receipt.tool_calls[0].response.content[0].text).toContain('score 100');
  });

  it('writes nothing at all when the connection is not ready', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseTestDouble({}, 'missing_credentials'), { db: asEvaluator, receiptsDir: dir, now: NOW });
    expect(result.status.state).toBe('missing_credentials');
    expect(result.receipt_path).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
    expect((await db.query<any>('select count(*)::int n from cm.quality_findings')).rows[0].n).toBe(0);
  });

  it('records a failed tool as an error, without its message, and no finding', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: new Error('401 Bearer sb_pat_secret'), list_inbox: { isError: true, content: [] } }), { receiptsDir: dir, now: NOW });
    expect(result.counts.errors).toBe(2);
    expect(result.rows).toEqual([]);
    expect(readFileSync(result.receipt_path!, 'utf8')).not.toContain('sb_pat_secret');
  });

  it('runs rules with persist false, branches on status, and keeps exploratory results exploratory', async () => {
    const dir = tmp();
    const answers: Record<string, unknown> = {
      'membership-bridge-class-domain': asLiveEnvelope({ status: 'pass', count: 0, query: 'select 1 from gym.ezf_active_memberships' }),
      'complete-run-nothing-unexplained': asLiveEnvelope({ status: 'fail', count: 2, query: 'select * from gym.ezf_active_membership_sync_runs' }),
      'complete-run-bridge-balance': asLiveEnvelope({ status: 'ambiguous' }),
      'complete-run-has-report-date': asLiveEnvelope({ status: 'unsupported' }),
      'matched-individual-client-backed': asStructured({ violations: 0 }),
      'accepted-decision-provenance': { content: [{ type: 'text', text: 'Looks fine to me' }] },
      'checkin-before-joined': asLiveEnvelope({ status: 'fail', count: 31 }),
    };
    const rules = Object.keys(answers).map((id) => ({ id, dataset: 'gym.fixture', rule: `fixture rule ${id}`, status: (id === 'checkin-before-joined' ? 'exploratory' : 'active') as 'active' | 'exploratory', basis: 'fixture' }));
    const client = new SodabaseTestDouble({ check_rule: (args: Record<string, unknown>) => answers[rules.find((r) => r.rule === args.rule)!.id] });
    const result = await pullFindings(client, { runRules: true, rules, receiptsDir: dir, now: NOW });
    expect(client.calls.every((c) => c.args.persist === false)).toBe(true);
    const byId = Object.fromEntries(result.rows.map((r) => [r.raw.rule_id, r]));
    expect(byId['membership-bridge-class-domain']).toMatchObject({ verdict: 'rule_held', finding_count: 0 });
    expect(byId['complete-run-nothing-unexplained']).toMatchObject({ verdict: 'rule_breached', finding_count: 2 });
    expect(byId['complete-run-bridge-balance']!.verdict).toBe('rule_ambiguous');
    expect(byId['complete-run-has-report-date']!.verdict).toBe('rule_unsupported');
    expect(byId['matched-individual-client-backed']).toMatchObject({ verdict: 'unknown', finding_count: 0 });
    expect(byId['accepted-decision-provenance']).toMatchObject({ verdict: 'unknown', finding_count: null });
    expect(byId['checkin-before-joined']).toMatchObject({ verdict: 'exploratory', finding_count: 31 });
    expect(result.counts).toMatchObject({ clean: 1, actionable: 1, exploratory: 1, undetermined: 4 });
    expect(JSON.stringify(result.rows) + readFileSync(result.receipt_path!, 'utf8')).not.toMatch(/select \*|select 1/);
  });

  it('reads the live envelope and branches on status', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseTestDouble({
      data_trust_health: asLiveEnvelope({ tables: [
        { table: 'gym.members', status: 'trusted', problems: [] },
        { table: 'gym.checkins', status: 'scanning', problems: [] },
        { table: 'gym.locations', status: 'untrusted', problems: [{ problem: 'duplicate ids', count: 2, finding_id: 'f1' }] },
      ] }),
    }), { db: asEvaluator, receiptsDir: dir, now: NOW });
    expect(result.quality_evidence).toBe('RECEIVED');
    expect(result.counts).toMatchObject({ clean: 1, undetermined: 1, actionable: 1 });
    expect(result.rows.find((r) => r.table_name === 'gym.locations')).toMatchObject({ verdict: 'untrusted', finding_count: 2, provider_finding_id: 'f1' });
  });

  it('removes row data hidden inside the live JSON string', async () => {
    const dir = tmp();
    const raw = asLiveEnvelope({ tables: 'not a list', rows: [{ email: 'jane@example.com' }], query: "select * from gym.members where email = 'jane@example.com'" });
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: raw }), { receiptsDir: dir, now: NOW });
    expect(readFileSync(result.receipt_path!, 'utf8')).not.toMatch(/jane@example\.com|select \*/);
  });

  it('handles the empty-state answers captured from the live service on 4 Nov 2026', async () => {
    const dir = tmp();
    const prose = (result: string) => ({ content: [{ type: 'text', text: result }], structuredContent: { result }, isError: false });
    const noTable = { dataset: 'gym.checkins', status: 'unknown', rule: '', column: null, family: '', failing_count: null, precise: true, note: "I don't have a table matching that in your workspace." };
    const result = await pullFindings(new SodabaseTestDouble({
      data_trust_health: prose('No data-trust scans yet \u2014 run data_trust_scan to check your watched tables.'),
      list_inbox: prose('Your inbox is clear \u2014 nothing needs a look right now.'),
      check_rule: asLiveEnvelope(noTable),
    }), { db: asEvaluator, runRules: true, rules: INTEGRITY_RULES.slice(0, 1), receiptsDir: dir, now: NOW });
    expect(result.quality_evidence).toBe('NO_SCANS_YET');
    expect(result.counts).toMatchObject({ unparsed: 0, clean: 0, actionable: 0, undetermined: 1 });
    expect(result.rows[0]).toMatchObject({ verdict: 'rule_unknown', finding_count: null });
  });

  it('reads failing_count, the count field the live check_rule returns', async () => {
    const dir = tmp();
    const answer = asLiveEnvelope({ dataset: 'gym.ezf_active_memberships', status: 'fail', failing_count: 7, precise: true });
    const result = await pullFindings(new SodabaseTestDouble({ check_rule: answer }), { runRules: true, rules: INTEGRITY_RULES.slice(0, 1), receiptsDir: dir, now: NOW });
    expect(result.rows[0]).toMatchObject({ verdict: 'rule_breached', finding_count: 7 });
  });

  it('still writes the receipt when the database fails, keeping only an error code', async () => {
    const dir = tmp();
    const broken = { query: async () => { throw Object.assign(new Error('password=hunter2 in message'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }); } };
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: asLiveEnvelope({ tables: [{ table: 'gym.members', status: 'trusted', problems: [] }] }) }), { db: broken, receiptsDir: dir, now: NOW });
    expect(result).toMatchObject({ inserted: 0, database_error: 'SELF_SIGNED_CERT_IN_CHAIN' });
    const receipt = readFileSync(result.receipt_path!, 'utf8');
    expect(JSON.parse(receipt)).toMatchObject({ database_error: 'SELF_SIGNED_CERT_IN_CHAIN', inserted_into_quality_findings: 0 });
    expect(receipt).not.toContain('hunter2');
  });

  it('the health-only probe calls nothing else, touches no database, and retains the sanitized response', async () => {
    const dir = tmp();
    const client = new SodabaseTestDouble({
      data_trust_health: asLiveEnvelope({ tables: [], query: 'select * from gym.members' }), list_inbox: asLiveEnvelope({ issues: [] }), explain: asLiveEnvelope({}), check_rule: asLiveEnvelope({ status: 'pass' }),
    });
    const untouchable = { query: async () => { throw new Error('the probe must not use the database'); } };
    const result = await pullFindings(client, { healthOnly: true, runRules: true, db: untouchable, receiptsDir: dir, now: NOW });
    expect(client.calls.map((c) => c.tool)).toEqual(['data_trust_health']);
    expect(result).toMatchObject({ database_error: null, inserted: 0, quality_evidence: 'NO_WATCHED_TABLES' });
    const receipt = readFileSync(result.receipt_path!, 'utf8');
    expect(JSON.parse(receipt).tool_calls[0].response.structuredContent.result.tables).toEqual([]);
    expect(receipt).not.toContain('select *');
    expect(JSON.parse(receipt).scope).toMatch(/not a healthy verdict/);
  });

  it('the probe asks whether Sodabase can see named tables and records each answer', async () => {
    const dir = tmp();
    const client = new SodabaseTestDouble({
      data_trust_health: asLiveEnvelope({ tables: [] }), list_datasets: asLiveEnvelope({ datasets: [] }), data_trust: asLiveEnvelope({ status: 'unknown' }),
    });
    const result = await pullFindings(client, { healthOnly: true, probeTables: ['gym.members', 'gym.checkins'], receiptsDir: dir, now: NOW });
    expect(client.calls.map((c) => c.tool)).toEqual(['data_trust_health', 'list_datasets', 'data_trust', 'data_trust']);
    const receipt = JSON.parse(readFileSync(result.receipt_path!, 'utf8'));
    expect(receipt.tool_calls.filter((c: any) => c.tool === 'data_trust').map((c: any) => c.table)).toEqual(['gym.members', 'gym.checkins']);
    expect(result.rows).toEqual([]);
  });

  it('classifies the real findings from the first scan of 4 Nov 2026, as validated against the mirror', async () => {
    const dir = tmp();
    const finding = (family: string, label: string, column: string | null, rule: string, failing_count: number, id: string) => ({ id, family, label, column, rule, failing_count, pct: null, low_confidence: false });
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: asLiveEnvelope({ note: 'Sodabase is read-only', tables: [
      { table: 'gym.finance_snapshots', status: 'untrusted', as_of: '2026-11-04', findings: [
        finding('referential', 'Broken references', 'location_id', 'every value must exist in locations.id', 28, 'a'),
        finding('unused', 'Unused column', 'flagged', 'effectively unused (>= 90% empty)', 217, 'b')] },
      { table: 'gym.members', status: 'untrusted', as_of: '2026-11-04', findings: [
        finding('business_rule', 'Rule broken', null, 'joined_at must be on or before expiration_date', 91, 'c'),
        finding('business_rule', 'Rule broken', null, 'joined_at must be on or before churned_at', 52, 'd'),
        finding('missing', 'Missing values', 'ezf_membership_number', 'should not be missing (null)', 64, 'e'),
        finding('unused', 'Unused column', 'churned_at', 'effectively unused (>= 90% empty)', 34330, 'f')] },
      { table: 'gym.ezf_active_memberships', status: 'untrusted', as_of: '2026-11-04', findings: [finding('composite_duplicate', 'Duplicate rows', null, "['location_id', 'ezf_membership_number'] should be unique together", 1, 'g')] },
      { table: 'gym.checkin_sync_runs', status: 'unknown', as_of: '2026-11-04', findings: [finding('unused', 'Unused column', 'error_code', 'effectively unused (>= 90% empty)', 6100, 'h')] },
      { table: 'gym.checkins', status: 'unknown', as_of: '2026-11-04', findings: [] },
    ] }) }), { db: asEvaluator, receiptsDir: dir, now: NOW });
    const byId = Object.fromEntries(result.rows.filter((r) => r.provider_finding_id).map((r) => [r.provider_finding_id, r]));
    for (const id of ['a', 'b', 'f', 'g', 'h']) expect(byId[id]!.raw.disposition).toBe('expected_by_definition');
    for (const id of ['c', 'd', 'e']) expect(byId[id]!.raw.disposition).toBe('actionable');
    expect(byId.c).toMatchObject({ finding_count: 91, verdict: 'untrusted', problem: 'Rule broken: joined_at must be on or before expiration_date' });
    expect(byId.a!.problem).toBe('Broken references: location_id: every value must exist in locations.id');
    expect(result.counts).toMatchObject({ actionable: 3, expected_by_definition: 5, undetermined: 1, clean: 0 });
  });

  it('judges an inbox issue by the findings it links to, not by its title or the provider summary', async () => {
    const dir = tmp();
    const issue = (id: string, table: string, title: string) => ({ id, dataset: `${SODABASE_PROJECT_REF}/postgres/gym/${table}`, kind: 'issue', status: 'open', title });
    const explain = (args: Record<string, unknown>) => asLiveEnvelope({ id: args.id, explanation: {
      method: 'llm-v1', summary: 'Records were likely deleted',
      findings: args.id === 'i1' ? [{ id: 'x', cols: ['location_id'], family: 'referential', failing_count: 28 }]
        : args.id === 'i2' ? [{ id: 'y', cols: ['ezf_membership_number', 'location_id'], family: 'composite_duplicate', failing_count: 1 }]
        : [{ id: 'z', cols: ['expiration_date', 'joined_at'], family: 'business_rule', failing_count: 91 }],
    } });
    const result = await pullFindings(new SodabaseTestDouble({
      list_inbox: asLiveEnvelope({ inbox: [issue('i1', 'finance_snapshots', 'gym.finance_snapshots \u2014 broken references'), issue('i2', 'ezf_active_memberships', 'gym.ezf_active_memberships \u2014 duplicates'), issue('i3', 'members', 'gym.members \u2014 rule broken')] }),
      explain,
    }), { receiptsDir: dir, now: NOW });
    const byId = Object.fromEntries(result.rows.map((r) => [r.provider_finding_id, r]));
    expect(byId.i1).toMatchObject({ table_name: 'gym.finance_snapshots', finding_count: 28 });
    expect(byId.i1!.raw.disposition).toBe('expected_by_definition');
    expect(byId.i2!.raw.disposition).toBe('expected_by_definition');
    expect(byId.i3!.raw.disposition).toBe('actionable');
    expect(result.counts).toMatchObject({ expected_by_definition: 2, actionable: 1 });
  });

  it('reports zero watched tables as no evidence, never as healthy', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseTestDouble({ data_trust_health: asLiveEnvelope({ tables: [] }) }), { db: asEvaluator, receiptsDir: dir, now: NOW });
    expect(result.quality_evidence).toBe('NO_WATCHED_TABLES');
    expect(result.counts.clean).toBe(0);
    const receipt = JSON.parse(readFileSync(result.receipt_path!, 'utf8'));
    expect(receipt).toMatchObject({ quality_evidence: 'NO_WATCHED_TABLES', project_ref: SODABASE_PROJECT_REF });
  });

  it('reads nothing and writes nothing if the workspace does not list the event project', async () => {
    const dir = tmp();
    const client = new SodabaseTestDouble({ data_trust_health: asLiveEnvelope({ tables: [] }) }, 'ready', 'some-other-project');
    const result = await pullFindings(client, { db: asEvaluator, receiptsDir: dir, now: NOW });
    expect(result.status.state).toBe('wrong_project');
    expect(result.status.reason).toContain(SODABASE_PROJECT_REF);
    expect(client.calls).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it('refuses a rule that would flag legitimate data before sending it', async () => {
    const client = new SodabaseTestDouble({ check_rule: asStructured({ violations: 0 }) });
    await expect(pullFindings(client, { runRules: true, rules: [{ id: 'bad', dataset: 'billed_items', rule: 'billed_at must not be in the future', status: 'active', basis: 'x' }], receiptsDir: tmp(), now: NOW })).rejects.toThrow(/RULE_FLAGS/);
    expect(client.calls).toEqual([]);
    expect(client.closed).toBe(true);
  });

  it('refuses to write a test double receipt to docs/receipts', async () => {
    await expect(pullFindings(new SodabaseTestDouble({}))).rejects.toThrow(/test double/);
  });

  it('refuses a database connection that is not evaluator_service, and a worker cannot write findings', async () => {
    const row = { provider: 'sodabase' as const, provider_finding_id: null, table_name: 't', verdict: 'trusted', problem: null, finding_count: null, severity: null, observed_at: 'now', raw: {} };
    await expect(insertQualityRows({ query: (t, p) => db.query(t, p) as any }, [row])).rejects.toThrow(/evaluator_service/);
    await db.exec('set role agent_worker');
    await expect(db.query(`insert into cm.quality_findings (provider, table_name, verdict) values ('sodabase','t','trusted')`)).rejects.toThrow(/permission denied/);
    await db.exec('reset role');
  });
});

describe('SodabaseClient over real Streamable HTTP, against a local test server', () => {
  let http: Server;
  let seen: { auth: string[]; tools: Array<{ name: string; args: unknown }> };
  const realFetch = globalThis.fetch;
  const TOKEN = 'test-token-not-real';
  let listedProject = SODABASE_PROJECT_REF;

  beforeEach(async () => {
    seen = { auth: [], tools: [] };
    listedProject = SODABASE_PROJECT_REF;
    const schema = (properties: object = {}) => ({ type: 'object' as const, properties });
    const tool = (name: string, properties: object = {}) => ({ name, description: name, inputSchema: schema(properties) });
    http = createServer(async (req, res) => {
      seen.auth.push(req.headers.authorization ?? '');
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401).end(); return; }
      const server = new McpServer({ name: 'local-test-server', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        tool('data_trust', { table: { type: 'string' } }), tool('data_trust_health'), tool('list_inbox'), tool('explain', { id: { type: 'string' } }),
        tool('check_rule', { dataset: { type: 'string' }, rule: { type: 'string' }, persist: { type: 'boolean' } }), tool('data_trust_scan'), tool('data_trust_sample', { finding_id: { type: 'string' } }), tool('connect_project', { project_ref: { type: 'string' } }),
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async (r) => {
        seen.tools.push({ name: r.params.name, args: r.params.arguments });
        if (r.params.name === 'connect_project') return { content: [{ type: 'text', text: JSON.stringify({ result: `Connected: Drako Agent Memory (${listedProject})` }) }] };
        return { content: [{ type: 'text', text: JSON.stringify({ result: JSON.stringify({ tables: [{ table: 'gym.members', status: 'trusted', problems: [] }], started: true }) }) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done));
    const { port } = http.address() as { port: number };
    // The endpoint is fixed by design, so requests are redirected to the local server at the fetch layer.
    globalThis.fetch = ((input: any, init: any) => realFetch(String(input).replace('https://sodabase.io/mcp', `http://127.0.0.1:${port}/mcp`), init)) as typeof fetch;
  });
  afterEach(async () => { globalThis.fetch = realFetch; await new Promise((done) => http.close(done)); });

  it('sends the bearer token, discovers tools, and hides data_trust_sample', async () => {
    const client = new SodabaseClient(TOKEN);
    const status = await client.connect();
    expect(status.state).toBe('ready');
    expect(status.catalog).toContain('data_trust_sample');
    expect(status.tools).not.toContain('data_trust_sample');
    expect(status.tools.sort()).toEqual(['check_rule', 'connect_project', 'data_trust', 'data_trust_health', 'data_trust_scan', 'explain', 'list_inbox']);
    expect(seen.auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    await expect(client.callReadTool('data_trust_sample' as any, { finding_id: 'x' })).rejects.toThrow(/allowlist/);
    await expect(client.callReadTool('check_rule', { dataset: 'd', rule: 'r', persist: true })).rejects.toThrow(/non-persistent/);
    await client.startScan();
    expect(seen.tools).toEqual([{ name: 'data_trust_scan', args: {} }]);
    await client.close();
  });

  it('reports a rejected token without exposing it, and pulls nothing', async () => {
    const client = new SodabaseClient('wrong-token');
    const dir = tmp();
    const result = await pullFindings(client, { receiptsDir: dir, now: NOW });
    expect(result.status.state).not.toBe('ready');
    expect(JSON.stringify(result.status)).not.toContain('wrong-token');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('refuses over the wire when the workspace lists another project', async () => {
    listedProject = 'another-project-ref';
    const dir = tmp();
    const result = await pullFindings(new SodabaseClient(TOKEN), { receiptsDir: dir, now: NOW });
    expect(result.status.state).toBe('wrong_project');
    expect(seen.tools.map((t) => t.name)).toEqual(['connect_project']);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('runs a full pull over the wire', async () => {
    const dir = tmp();
    const result = await pullFindings(new SodabaseClient(TOKEN), { receiptsDir: dir, now: NOW, runRules: true });
    expect(result.rows.some((r) => r.table_name === 'gym.members' && r.verdict === 'trusted')).toBe(true);
    expect(seen.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['data_trust_health', 'list_inbox', 'check_rule']));
    expect(seen.tools.some((t) => t.name === 'data_trust_scan' || t.name === 'data_trust_sample')).toBe(false);
    // Only ever lists projects. Passing project_ref would provision a role and start watching.
    expect(seen.tools.filter((t) => t.name === 'connect_project')).toEqual([{ name: 'connect_project', args: {} }]);
    expect(existsSync(result.receipt_path!)).toBe(true);
  }, 30_000);
});
