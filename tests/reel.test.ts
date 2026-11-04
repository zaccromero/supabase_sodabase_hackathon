import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXTRACTION_SCHEMA, normalizeExtraction, promptSha256, REEL_PROMPT, type Extractor } from '../src/reel/extract';
import { buildPrompt, hermesExtractor, hermesModelId, parseJsonReply, planFrames, type Exec } from '../src/reel/hermes';
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
  const run = (filePath: string, model = 'test-model') => importReel({ filePath, db, extractor: extractor as unknown as Extractor, model });

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
      await importReel({ filePath: file('s.mp4', 's'), db: spy, extractor: extractor as unknown as Extractor, model: 'test-model' });
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

describe('hermes extractor', () => {
  const media = { path: '/Users/x/owner-private-name.mp4', mimeType: 'video/mp4', sizeBytes: 4, sha256: 'f'.repeat(64) };
  const PY = '/hermes/.venv/bin/python';
  const script = (over: { audio?: boolean; whisperFails?: boolean; reply?: string; hermesFails?: boolean } = {}) => {
    const calls: Array<{ cmd: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
    let sheetDir = '';
    const exec: Exec = async (cmd, args, opts) => {
      calls.push({ cmd, args, ...(opts?.env ? { env: opts.env } : {}) });
      if (cmd === 'ffprobe') return JSON.stringify({ format: { duration: '32.0' }, streams: [{ codec_type: 'video' }, ...(over.audio === false ? [] : [{ codec_type: 'audio' }])] });
      if (cmd === 'ffmpeg') {
        const out = args.at(-1)!;
        if (out.includes('sheet-')) { sheetDir = out.replace(/\/sheet-.*$/, ''); writeFileSync(join(sheetDir, 'sheet-002.jpg'), 'b'); writeFileSync(join(sheetDir, 'sheet-001.jpg'), 'a'); }
        return '';
      }
      if (cmd === PY) { if (over.whisperFails) throw new Error('REEL_TOOL_FAILED'); return JSON.stringify([{ start_s: 1, end_s: 2, text: 'Hinge at the hips' }]); }
      if (over.hermesFails) throw new Error('REEL_TOOL_FAILED: hermes 1');
      return over.reply ?? JSON.stringify(GOOD);
    };
    return { calls, exec, dir: () => sheetDir };
  };
  const make = (exec: Exec) => hermesExtractor({ exec, python: () => PY });
  const hermesCall = (calls: ReturnType<typeof script>['calls']) => calls.find((c) => c.cmd.endsWith('/hermes'))!;

  it('sends sheets in order and the transcript, keeps memory out, and limits Hermes to vision', async () => {
    const s = script();
    expect(await make(s.exec)(media, 'REEL PROMPT', 'm')).toEqual(GOOD);
    const { args } = hermesCall(s.calls);
    expect(args).toEqual(expect.arrayContaining(['-t', 'vision', '--ignore-rules']));
    expect(args).not.toContain('--yolo');
    const prompt = args[1]!;
    expect(prompt.startsWith('REEL PROMPT')).toBe(true);
    expect(prompt.indexOf('sheet-001.jpg')).toBeLessThan(prompt.indexOf('sheet-002.jpg'));
    expect(prompt).toContain('Hinge at the hips');
    expect(prompt).toContain('untrusted');
  });
  it('never passes the owner filename or any model API key', async () => {
    const s = script();
    await make(s.exec)(media, 'p', 'm');
    expect(hermesCall(s.calls).args.join(' ')).not.toContain('owner-private-name');
    expect(hermesCall(s.calls).env).toBeUndefined();
    const src = readFileSync(new URL('../src/reel/hermes.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/reel/cli.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/GEMINI|GOOGLE_|generativelanguage|OPENAI_API_KEY/);
  });
  it('transcribes offline with the local model', async () => {
    const s = script();
    await make(s.exec)(media, 'p', 'm');
    const py = s.calls.find((c) => c.cmd === PY)!;
    expect(py.env?.HF_HUB_OFFLINE).toBe('1');
    expect(py.args.join(' ')).toContain('local_files_only=True');
  });
  it('removes its temporary frames, including after a failure', async () => {
    const ok = script();
    await make(ok.exec)(media, 'p', 'm');
    expect(existsSync(ok.dir())).toBe(false);
    const bad = script({ hermesFails: true });
    await expect(make(bad.exec)(media, 'p', 'm')).rejects.toThrow('REEL_TOOL_FAILED');
    expect(existsSync(bad.dir())).toBe(false);
  });
  it('says so when speech could not be transcribed, instead of hiding it', async () => {
    const out = normalizeExtraction(await make(script({ whisperFails: true }).exec)(media, 'p', 'm'));
    expect(out.unclear_steps.at(-1)!.reason).toContain('could not be transcribed');
  });
  it('skips transcription when the video has no audio', async () => {
    const s = script({ audio: false });
    await make(s.exec)(media, 'p', 'm');
    expect(s.calls.some((c) => c.cmd === PY)).toBe(false);
  });
  it('rejects a reply that is not usable, so nothing can be stored', async () => {
    await expect(make(script({ reply: 'I could not view the images.' }).exec)(media, 'p', 'm')).rejects.toThrow(/REEL_EXTRACTION_INVALID/);
    const empty = await make(script({ reply: '{"technique":"","steps":[],"unclear_steps":[]}' }).exec)(media, 'p', 'm');
    expect(() => normalizeExtraction(empty)).toThrow(/REEL_EXTRACTION_INVALID/);
    const emptyNoSpeech = await make(script({ whisperFails: true, reply: '{"technique":"x","steps":[],"unclear_steps":[]}' }).exec)(media, 'p', 'm');
    expect(() => normalizeExtraction(emptyNoSpeech)).toThrow(/REEL_EXTRACTION_INVALID/);
  });
  it('parses JSON with surrounding text and rejects anything else', () => {
    expect(parseJsonReply('Here it is:\n{"a":1}\n')).toEqual({ a: 1 });
    expect(() => parseJsonReply('no json')).toThrow(/REEL_EXTRACTION_INVALID/);
  });
  it('samples one frame a second and caps long videos', () => {
    expect(planFrames(30)).toEqual({ fps: 1, secondsPerFrame: 1 });
    expect(planFrames(640).secondsPerFrame).toBe(10);
    expect(() => planFrames(NaN)).toThrow('REEL_BAD_DURATION');
  });
  it('names the real Hermes model in the cache key', () => {
    expect(hermesModelId('model:\n  provider: openai-codex\n  default: gpt-6.1-sol\nother: 1\n')).toBe('hermes:gpt-6.1-sol:frames-v1');
    expect(() => hermesModelId('other: 1\n')).toThrow('REEL_HERMES_MODEL_UNKNOWN');
  });
  it('puts the schema in the prompt', () => {
    expect(buildPrompt({ reelPrompt: 'x', sheets: ['/a.jpg'], secondsPerFrame: 1, transcript: [] })).toContain(JSON.stringify(EXTRACTION_SCHEMA));
  });
});
