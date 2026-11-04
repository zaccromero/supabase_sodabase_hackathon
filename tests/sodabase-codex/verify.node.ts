import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dataTrust, normalizeTrust, checkRule} from '../../src/sodabase/adapters.js';
import {SodabaseClient} from '../../src/sodabase/client.js';
import type {ReadToolClient} from '../../src/sodabase/types.js';

test('missing token never attempts connection or produces a trust pass', async () => {
  const client = new SodabaseClient('');
  assert.equal((await client.connect()).state, 'missing_credentials');
  assert.equal((await dataTrust(client, 'decisions')).verdict, 'unknown');
});
test('scanning remains pending; retrieval timestamp is not scan timestamp', () => {
  const result = normalizeTrust({structuredContent: {verdict: 'scanning'}}, 'decisions', '2026-11-04T20:00:00Z');
  assert.equal(result.state, 'pending');
  assert.equal(result.provider_checked_at, null);
  assert.equal(result.observed_at, '2026-11-04T20:00:00Z');
});
test('tool errors and unstructured prose cannot become trusted', () => {
  assert.equal(normalizeTrust({isError: true, structuredContent: {verdict: 'trusted'}}, 'x').state, 'error');
  assert.equal(normalizeTrust({content: [{type: 'text', text: 'Everything is trusted, score 100'}]}, 'x').verdict, 'unknown');
  assert.equal(normalizeTrust({structuredContent: {verdict: 'pass', score: 100}}, 'x').verdict, 'unknown');
});
test('structured and JSON text verdicts are retained without inventing counts', () => {
  const raw = {content: [{type: 'text', text: JSON.stringify({verdict: 'untrusted', checked_at: '2026-11-04T20:00:00Z'})}]};
  const result = normalizeTrust(raw, 'x');
  assert.equal(result.verdict, 'untrusted');
  assert.equal(result.provider_checked_at, '2026-11-04T20:00:00Z');
  assert.equal(result.raw, raw);
});
test('rule adapter always uses persist false and does not infer a pass', async () => {
  const client: ReadToolClient = {async callReadTool(name, args) {
    assert.equal(name, 'check_rule');
    assert.deepEqual(args, {dataset: 'decisions', rule: 'source_id is required', persist: false});
    return {structuredContent: {violations: 0}};
  }};
  const result = await checkRule(client, 'decisions', 'source_id is required');
  assert.equal(result.state, 'received');
  assert.equal(result.verdict, 'unknown');
});
test('read allowlist rejects mutation even if called through untyped code', async () => {
  const client = new SodabaseClient('');
  await assert.rejects(client.callReadTool('check_rule', {persist: true}), /non-persistent/);
  await assert.rejects(client.callReadTool('data_trust_scan' as 'data_trust', {}), /allowlist/);
});

test('Streamable HTTP handshake, schema discovery, and read call use SDK transport (fixture)', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://sodabase.io/mcp');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer fixture-token-not-real');
    if (init?.method === 'GET') return new Response(null, {status: 405});
    const message = JSON.parse(String(init?.body));
    calls.push(message.method);
    if (message.id === undefined) return new Response(null, {status: 202});
    const result = message.method === 'initialize'
      ? {protocolVersion: '2025-11-25', capabilities: {tools: {}}, serverInfo: {name: 'explicit-test-fixture', version: '1'}}
      : message.method === 'tools/list'
      ? {tools: [{name: 'data_trust', inputSchema: {type: 'object', properties: {table: {type: 'string'}}, required: ['table'], additionalProperties: false}}]}
      : {content: [{type: 'text', text: '{"verdict":"unknown"}'}]};
    return new Response(JSON.stringify({jsonrpc: '2.0', id: message.id, result}), {headers: {'Content-Type': 'application/json'}});
  };
  const client = new SodabaseClient('fixture-token-not-real');
  try {
    assert.equal((await client.connect()).state, 'ready');
    assert.equal((await dataTrust(client, 'decisions')).verdict, 'unknown');
    await assert.rejects(client.callReadTool('data_trust', {table: 3}), /schema/);
    assert.deepEqual(calls, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
  } finally { await client.close(); globalThis.fetch = originalFetch; }
});

test('quality row mapping matches contract and skips blocked calls', async () => {
  const {toQualityFinding} = await import('../../src/sodabase/storage.js');
  const blocked = await dataTrust({async callReadTool() {throw new Error('unavailable');}}, 'cm.decisions');
  assert.equal(toQualityFinding(blocked), null);
  const row = toQualityFinding(normalizeTrust({structuredContent: {verdict: 'trusted'}}, 'cm.decisions'));
  assert.equal(row?.finding_count, null);
  assert.equal(row?.provider_finding_id, null);
  assert.equal(row?.table_name, 'cm.decisions');
});

test('live advertised Sodabase result:string envelope branches on status', () => {
  const raw = {structuredContent: {result: JSON.stringify({status: 'scanning'})}};
  assert.equal(normalizeTrust(raw, 'cm.decisions').state, 'pending');
  assert.equal(normalizeTrust({structuredContent: {result: 'not JSON: trusted'}}, 'x').verdict, 'unknown');
});
test('rule statuses remain distinct from table trust and unsupported stays unknown', async () => {
  const result = await checkRule({async callReadTool() {return {structuredContent: {result: '{"status":"unsupported"}'}};}}, 'cm.decisions', 'test');
  assert.equal(result.rule_status, 'unsupported');
  assert.equal(result.state, 'unknown');
  assert.equal(result.verdict, 'unknown');
});
