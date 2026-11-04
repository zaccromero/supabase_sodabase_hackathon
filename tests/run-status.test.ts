// The handler against the real cm.v_run_status view on PGlite, with the same read-only role and
// statements the deployed function uses. Every run below is a test fixture.
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHandler, createRateLimiter, READ_ROLE, STATEMENT_TIMEOUT, STATUS_SQL, type ReadStatus, type StatusRow } from '../supabase/functions/run-status/handler.js';

const dir = new URL('../supabase/migrations/', import.meta.url);
const SECRET_TASK = 'TASK_TEXT_MUST_NOT_LEAVE';
let db: PGlite;
let runId: string;

const readStatus: ReadStatus = (id) => db.transaction(async (tx) => {
  await tx.query('set transaction read only');
  await tx.query(`set local role ${READ_ROLE}`);
  await tx.query(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
  return (await tx.query<StatusRow>(STATUS_SQL, [id])).rows[0];
}) as Promise<StatusRow | undefined>;
const get = (query: string, init: RequestInit = {}) => new Request(`https://edge.test/run-status${query}`, init);
const fresh = () => createHandler(readStatus);

beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role postgres_app nologin; create role soda_readonly_c68226d2fe1d nologin;');
  for (const file of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(file, dir), 'utf8').replace(/^grant .* to postgres;$/gm, ''));
  const run = await db.query<{ id: string }>(`insert into cm.runs (profile, task, status) values ('milo_pitch', $1, 'running') returning id`, [SECRET_TASK]);
  runId = run.rows[0]!.id;
});

describe('run-status edge function', () => {
  it('returns gate status from the view, with no task text', async () => {
    const response = await fresh()(get(`?run_id=${runId}`));
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).not.toContain(SECRET_TASK);
    expect(JSON.parse(raw)).toMatchObject({
      run_id: runId, profile: 'milo_pitch', status: 'running', gate_clear: false,
      missing: [{ check_id: null, reason: 'CONTRACT_NOT_FROZEN', evaluation_id: null }],
    });
    expect(response.headers.get('cache-control')).toBe('private, max-age=5');
    expect(response.headers.get('access-control-allow-origin')).toBe('https://company-memory-zacc-r.vercel.app');
  });

  it('the read role can only read: a write in the same transaction is refused', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.query('set transaction read only');
      await tx.query(`set local role ${READ_ROLE}`);
      await tx.query(`update cm.runs set status = 'failed' where id = $1`, [runId]);
    })).rejects.toThrow();
    expect((await db.query<{ status: string }>('select status from cm.runs where id = $1', [runId])).rows[0]!.status).toBe('running');
  });

  it('answers a bad or unknown id and a wrong method with fixed codes', async () => {
    const handler = fresh();
    expect((await handler(get(''))).status).toBe(400);
    const injection = await handler(get(`?run_id=${encodeURIComponent("x' or '1'='1")}`));
    expect([injection.status, await injection.json()]).toEqual([400, { error: 'INVALID_RUN_ID' }]);
    const unknown = await handler(get('?run_id=00000000-0000-4000-8000-000000000000'));
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: 'RUN_NOT_FOUND' }]);
    expect((await handler(get(`?run_id=${runId}`, { method: 'POST' }))).status).toBe(405);
    expect((await handler(get('', { method: 'OPTIONS' }))).status).toBe(204);
  });

  it('never returns database error text', async () => {
    const handler = createHandler(async () => { throw new Error('connect failed postgres://user:hunter2@db.internal'); });
    const response = await handler(get(`?run_id=${runId}`));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"UNAVAILABLE"}');
  });

  it('drops anything outside the allowlist from a row, including inside missing', async () => {
    const row = {
      run_id: runId, profile: 'gym_operator', status: 'blocked', memory_mode: 'on', attempt_no: 1, output_sha256: 'a', contract_sha256: 'b',
      missing: [{ check_id: 'c', reason: 'FAILED', evaluation_id: 'e', leaked: SECRET_TASK }], created_at: new Date('2026-11-04T00:00:00Z'), completed_at: null,
      task: SECRET_TASK,
    } as StatusRow;
    const raw = await (await createHandler(async () => row)(get(`?run_id=${runId}`))).text();
    expect(raw).not.toContain(SECRET_TASK);
    expect(JSON.parse(raw).created_at).toBe('2026-11-04T00:00:00.000Z');
  });

  it('limits each client and reopens after the window, before touching the database', async () => {
    let at = 0;
    let reads = 0;
    const handler = createHandler(async () => { reads += 1; return undefined; }, createRateLimiter({ limit: 2, windowMs: 1000, maxClients: 10 }, () => at));
    const from = (ip: string) => get(`?run_id=${runId}`, { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    expect((await handler(from('1.1.1.1'))).status).toBe(404);
    expect((await handler(from('1.1.1.1'))).status).toBe(404);
    const limited = await handler(from('1.1.1.1'));
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '1']);
    expect(reads).toBe(2);
    expect((await handler(from('2.2.2.2'))).status).toBe(404);
    at = 1000;
    expect((await handler(from('1.1.1.1'))).status).toBe(404);
  });

  it('keeps the client map bounded', () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, maxClients: 2 }, () => 0);
    limiter('a'); limiter('b'); limiter('c');
    expect(limiter('c').allowed).toBe(false);
    expect(limiter('a').allowed).toBe(true);
  });
});
