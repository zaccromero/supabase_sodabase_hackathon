// Gemini Files API plus generateContent, over fetch. The key travels in a header, never a URL.
import { openAsBlob } from 'node:fs';
import { EXTRACTION_SCHEMA } from './extract';

const BASE = 'https://generativelanguage.googleapis.com';
const GENERATE_BACKOFF_MS = [5000, 15000, 30000];

export interface LocalMedia { path: string; mimeType: string; sizeBytes: number; sha256: string; }
export type Extractor = (media: LocalMedia, prompt: string, model: string) => Promise<unknown>;
export interface GeminiOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  maxPolls?: number;
  body?: (path: string) => Promise<Blob>;
}

/** Status only in errors. Provider bodies can echo request details. */
const check = (res: Response, step: string) => { if (!res.ok) throw new Error(`GEMINI_${step}_FAILED: HTTP ${res.status}`); };

export function geminiExtractor(opts: GeminiOptions): Extractor {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const auth = { 'x-goog-api-key': opts.apiKey };
  const readBody = opts.body ?? ((p: string) => openAsBlob(p));

  return async (media, prompt, model) => {
    const start = await f(`${BASE}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        ...auth,
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(media.sizeBytes),
        'X-Goog-Upload-Header-Content-Type': media.mimeType,
        'Content-Type': 'application/json',
      },
      // The name is the content hash, so the owner's filename never leaves this machine.
      body: JSON.stringify({ file: { display_name: `reel-${media.sha256.slice(0, 16)}` } }),
    });
    check(start, 'UPLOAD_START');
    const uploadUrl = start.headers.get('x-goog-upload-url');
    if (!uploadUrl) throw new Error('GEMINI_UPLOAD_START_FAILED: no upload url');

    const finish = await f(uploadUrl, {
      method: 'POST',
      headers: { ...auth, 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: await readBody(media.path),
    });
    check(finish, 'UPLOAD');
    const file = ((await finish.json()) as { file?: { name?: string; uri?: string } }).file;
    if (!file?.name || !file.uri) throw new Error('GEMINI_UPLOAD_FAILED: no file handle');

    try {
      const maxPolls = opts.maxPolls ?? 60;
      for (let i = 0; ; i++) {
        const s = await f(`${BASE}/v1beta/${file.name}`, { headers: auth });
        check(s, 'POLL');
        const state = ((await s.json()) as { state?: string }).state;
        if (state === 'ACTIVE') break;
        if (state === 'FAILED') throw new Error('GEMINI_FILE_FAILED');
        if (i >= maxPolls) throw new Error('GEMINI_FILE_TIMEOUT');
        await sleep(opts.pollMs ?? 5000);
      }
      const body = JSON.stringify({
        contents: [{ role: 'user', parts: [{ fileData: { mimeType: media.mimeType, fileUri: file.uri } }, { text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseJsonSchema: EXTRACTION_SCHEMA },
      });
      let gen: Response;
      // Bounded retry: only rate limits and overload are worth repeating.
      for (let attempt = 0; ; attempt++) {
        gen = await f(`${BASE}/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body });
        if (![429, 500, 503].includes(gen.status) || attempt >= GENERATE_BACKOFF_MS.length) break;
        await sleep(GENERATE_BACKOFF_MS[attempt]!);
      }
      check(gen, 'GENERATE');
      const json = (await gen.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const out = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!out) throw new Error('GEMINI_GENERATE_FAILED: empty response');
      try { return JSON.parse(out) as unknown; } catch { throw new Error('REEL_EXTRACTION_INVALID: not json'); }
    } finally {
      // Best effort. Google also expires uploaded files on its own.
      await f(`${BASE}/v1beta/${file.name}`, { method: 'DELETE', headers: auth }).catch(() => {});
    }
  };
}
