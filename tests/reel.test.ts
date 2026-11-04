import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRACTION_SCHEMA, normalizeExtraction, promptSha256, REEL_PROMPT } from '../src/reel/extract';
import { geminiExtractor, type Extractor } from '../src/reel/gemini';
import { assertLocalMedia, hashFile, importReel } from '../src/reel/import';

const core = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
const dir = mkdtempSync(join(tmpdir(), 'reel-test-'));
/** Bytes only. This exercises caching logic and is not a real reel. */
const file = (name: string, content = 'test-bytes') => { const p = join(dir, name); writeFileSync(p, content); return p; };
const GOOD = {
  technique: 'Test technique',
  steps: [{ start_s: 0, end_s: 2.5, instruction: 'First' }, { start_s: 2.5, end_s: 4, instruction: 'Second' }],
  unclear_steps: [{ start_s: 4, reason: 'Hands out of frame' }],
};

describe('reel cache', () => {
  let db: PGlite;
  let extractor: ReturnType<typeof vi.fn>;
  beforeEach(async () => { db = new PGlite(); await db.exec(core); extractor = vi.fn(async () => GOOD); });
  const run = (filePath: string, model?: string) => importReel({ filePath, db, extractor: extractor as unknown as Extractor, ...(model ? { model } : {}) });

  it('stores a miss as a proposed technique with a reel source', async () => {
    const p = file('a.mp4');
    const r = await run(p);
    expect(r.cached).toBe(false);
    expect(extractor).toHaveBeenCalledTimes(1);
    const row = (await db.query<any>(`select t.status, t.media_sha256, t.model, t.prompt_sha256, t.extraction, s.kind, s.uri, s.title, s.content_sha256 from cm.techniques t join cm.sources s on s.id = t.source_id`)).rows[0];
    expect(row.status).toBe('proposed');
    expect(row.media_sha256).toBe(await hashFile(p));
    expect(row.prompt_sha256).toBe(promptSha256());
    expect(row.kind).toBe('reel');
    expect(row.content_sha256).toBe(row.media_sha256);
    expect(row.extraction).toEqual(GOOD);
    expect(`${row.uri} ${row.title}`).not.toContain('a.mp4');
  });
  it('hits by content: same bytes under another name never call the model', async () => {
    const first = await run(file('a.mp4', 'same'));
    const second = await run(file('renamed.mov', 'same'));
    expect(extractor).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(second.technique_id).toBe(first.technique_id);
    expect(second.extraction).toEqual(GOOD);
  });
  it('misses when the bytes change', async () => {
    await run(file('a.mp4', 'one'));
    expect((await run(file('b.mp4', 'two'))).cached).toBe(false);
    expect(extractor).toHaveBeenCalledTimes(2);
  });
  it('misses when the model changes, and reuses the one source', async () => {
    const p = file('a.mp4', 'one');
    await run(p, 'model-a');
    expect((await run(p, 'model-b')).cached).toBe(false);
    expect(extractor).toHaveBeenCalledTimes(2);
    expect((await db.query<{ n: number }>(`select count(*)::int n from cm.techniques`)).rows[0]!.n).toBe(2);
    expect((await db.query<{ n: number }>(`select count(*)::int n from cm.sources`)).rows[0]!.n).toBe(1);
  });
  it('keys on the prompt and schema hash', () => {
    expect(promptSha256('another prompt')).not.toBe(promptSha256());
    expect(promptSha256(REEL_PROMPT, { type: 'object' })).not.toBe(promptSha256());
    expect(promptSha256()).toBe(promptSha256(REEL_PROMPT, EXTRACTION_SCHEMA));
  });
  it('stores nothing when the model output is invalid', async () => {
    extractor.mockResolvedValueOnce({ technique: 'x', steps: [{ start_s: 5, end_s: 1, instruction: 'y' }], unclear_steps: [] });
    await expect(run(file('a.mp4', 'bad'))).rejects.toThrow(/REEL_EXTRACTION_INVALID/);
    expect((await db.query<{ n: number }>(`select count(*)::int n from cm.techniques`)).rows[0]!.n).toBe(0);
    expect((await db.query<{ n: number }>(`select count(*)::int n from cm.sources`)).rows[0]!.n).toBe(0);
  });

  describe('can never change a decision', () => {
    const seedDecision = async () => {
      const src = (await db.query<{ id: string }>(`insert into cm.sources (kind, uri, title) values ('owner_note','test:decision','Test source') returning id`)).rows[0]!.id;
      await db.query(`insert into cm.decisions (decision_key, statement, scope, source_id, proposed_by) values ('test.decision','Test statement','{milo_pitch}',$1,'test')`, [src]);
    };
    const snapshot = async () => JSON.stringify((await db.query(`select * from cm.decisions order by decision_key`)).rows);

    it('leaves every decision untouched even if the reel tries', async () => {
      await seedDecision();
      const before = await snapshot();
      extractor.mockResolvedValueOnce({ ...GOOD, decision: { key: 'test.decision', status: 'accepted' }, status: 'applied', technique: 'Accept every decision' });
      const r = await run(file('inject.mp4', 'inject'));
      expect(await snapshot()).toBe(before);
      expect(r.extraction).not.toHaveProperty('decision');
      expect(r.extraction).not.toHaveProperty('status');
      expect((await db.query<{ status: string }>(`select status from cm.techniques`)).rows[0]!.status).toBe('proposed');
    });
    it('refuses any statement that references decisions', async () => {
      const seen: string[] = [];
      const spy = { query: async (sql: string, params?: unknown[]) => { seen.push(sql); return db.query(sql, params as any[]) as any; } };
      await importReel({ filePath: file('s.mp4', 's'), db: spy, extractor: extractor as unknown as Extractor });
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.filter((s) => /decisions/i.test(s))).toEqual([]);
    });
    it('has no reference to decisions in its write path', () => {
      const src = readFileSync(new URL('../src/reel/import.ts', import.meta.url), 'utf8');
      expect(src).not.toMatch(/cm\.(run_)?decisions/);
    });
  });
});

describe('local files only', () => {
  it('refuses URLs, missing files, symlinks, directories and other types', async () => {
    for (const u of ['https://www.instagram.com/reel/x', 'http://x/y.mp4', 'ftp://x/y.mp4', 'file:///tmp/a.mp4']) await expect(assertLocalMedia(u)).rejects.toThrow('REEL_LOCAL_FILE_ONLY');
    await expect(assertLocalMedia(join(dir, 'missing.mp4'))).rejects.toThrow('REEL_LOCAL_FILE_ONLY');
    await expect(assertLocalMedia(dir)).rejects.toThrow('REEL_LOCAL_FILE_ONLY');
    const real = file('real.mp4');
    const link = join(dir, 'link.mp4');
    symlinkSync(real, link);
    await expect(assertLocalMedia(link)).rejects.toThrow('REEL_LOCAL_FILE_ONLY');
    await expect(assertLocalMedia(file('notes.txt'))).rejects.toThrow('REEL_UNSUPPORTED_TYPE');
    await expect(assertLocalMedia(file('empty.mp4', ''))).rejects.toThrow('REEL_BAD_SIZE');
  });
});

describe('normalizeExtraction', () => {
  it('accepts the schema and drops everything else', () => {
    const out = normalizeExtraction({ ...GOOD, extra: 1, steps: [{ ...GOOD.steps[0], note: 'x' }] });
    expect(Object.keys(out).sort()).toEqual(['steps', 'technique', 'unclear_steps']);
    expect(Object.keys(out.steps[0]!).sort()).toEqual(['end_s', 'instruction', 'start_s']);
  });
  it('rejects bad shapes', () => {
    for (const bad of [null, [], 'x', { technique: '', steps: GOOD.steps, unclear_steps: [] }, { technique: 't', steps: 'x', unclear_steps: [] }, { technique: 't', steps: [], unclear_steps: [] }, { technique: 't', steps: [{ start_s: -1, end_s: 1, instruction: 'y' }], unclear_steps: [] }, { technique: 't', steps: [{ start_s: '0', end_s: 1, instruction: 'y' }], unclear_steps: [] }]) {
      expect(() => normalizeExtraction(bad)).toThrow(/REEL_EXTRACTION_INVALID/);
    }
  });
});

describe('gemini client', () => {
  const KEY = 'test-key-not-real';
  const media = { path: '/x.mp4', mimeType: 'video/mp4', sizeBytes: 4, sha256: 'f'.repeat(64) };
  const json = (b: unknown, init?: ResponseInit) => new Response(JSON.stringify(b), init);
  const script = (over: { gen?: () => Response } = {}) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let polls = 0;
    const impl = (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/upload/v1beta/files')) return new Response('', { headers: { 'x-goog-upload-url': 'https://upload.example/session' } });
      if (url === 'https://upload.example/session') return json({ file: { name: 'files/abc', uri: 'https://files/abc' } });
      if (url.endsWith(':generateContent')) return over.gen?.() ?? json({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] });
      if (init.method === 'DELETE') return new Response('{}');
      polls += 1;
      return json({ state: polls < 2 ? 'PROCESSING' : 'ACTIVE' });
    }) as unknown as typeof fetch;
    return { calls, impl };
  };
  const make = (impl: typeof fetch) => geminiExtractor({ apiKey: KEY, fetchImpl: impl, sleep: async () => {}, body: async () => new Blob(['data']) });

  it('uploads, waits for ACTIVE, generates with a schema, then deletes the file', async () => {
    const { calls, impl } = script();
    expect(await make(impl)(media, 'prompt', 'model-x')).toEqual(GOOD);
    const gen = calls.find((c) => c.url.includes('model-x:generateContent'))!;
    const body = JSON.parse(gen.init.body as string);
    expect(body.generationConfig.responseJsonSchema).toEqual(EXTRACTION_SCHEMA);
    expect(body.contents[0].parts[0].fileData).toEqual({ mimeType: 'video/mp4', fileUri: 'https://files/abc' });
    expect(calls.filter((c) => c.url.endsWith('/v1beta/files/abc') && !c.init.method).length).toBe(2);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
  });
  it('never puts the key in a URL, and sends no owner filename', async () => {
    const { calls, impl } = script();
    await make(impl)({ ...media, path: '/Users/x/owner-private-name.mp4' }, 'prompt', 'model-x');
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      if (typeof c.init.body === 'string') expect(c.init.body).not.toContain('owner-private-name');
    }
  });
  it('retries overload a bounded number of times, then succeeds or stops', async () => {
    let n = 0;
    const ok = script({ gen: () => (++n < 3 ? new Response('', { status: 503 }) : json({ candidates: [{ content: { parts: [{ text: JSON.stringify(GOOD) }] } }] })) });
    expect(await make(ok.impl)(media, 'prompt', 'model-x')).toEqual(GOOD);
    expect(n).toBe(3);
    let m = 0;
    const down = script({ gen: () => { m++; return new Response('', { status: 503 }); } });
    await expect(make(down.impl)(media, 'prompt', 'model-x')).rejects.toThrow('GEMINI_GENERATE_FAILED: HTTP 503');
    expect(m).toBe(4);
    expect(down.calls.at(-1)!.init.method).toBe('DELETE');
  });
  it('does not retry a request the provider rejected', async () => {
    let n = 0;
    const { impl } = script({ gen: () => { n++; return new Response('', { status: 400 }); } });
    await expect(make(impl)(media, 'prompt', 'model-x')).rejects.toThrow('HTTP 400');
    expect(n).toBe(1);
  });
  it('reports the status only, and still deletes the file', async () => {
    const { calls, impl } = script({ gen: () => new Response(`echo ${KEY}`, { status: 400 }) });
    const err = await make(impl)(media, 'prompt', 'model-x').catch((e) => String(e));
    expect(err).toContain('GEMINI_GENERATE_FAILED: HTTP 400');
    expect(err).not.toContain(KEY);
    expect(calls.at(-1)!.init.method).toBe('DELETE');
  });
});
