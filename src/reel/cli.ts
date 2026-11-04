#!/usr/bin/env tsx
// pnpm tsx src/reel/cli.ts --file /absolute/path/to/owner-reel.mp4 [--model id]
//   Hashes the file, reuses the cache or calls Gemini, stores a proposed technique.
// pnpm tsx src/reel/cli.ts --file ... --extract-only
//   Calls Gemini and prints the shape of the result. Touches no database.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { DEFAULT_MODEL, normalizeExtraction, REEL_PROMPT } from './extract';
import { geminiExtractor } from './gemini';
import { assertLocalMedia, hashFile, importReel } from './import';

const secret = (project: string, config: string, name: string) => {
  try { return execFileSync('doppler', ['--no-check-version', 'secrets', 'get', name, '--plain', '-p', project, '-c', config], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
};
const blocked = (what: string): never => { console.error(`BLOCKED: ${what}`); process.exit(2); };

async function main() {
  const { values } = parseArgs({ options: { file: { type: 'string' }, model: { type: 'string' }, 'extract-only': { type: 'boolean' } } });
  if (!values.file) blocked('--file is required: an owner-supplied local video');
  const file = values.file!;
  const model = values.model ?? DEFAULT_MODEL;
  const apiKey = secret('milo', 'dev', 'GOOGLE_GEMINI_API_KEY') ?? blocked('GOOGLE_GEMINI_API_KEY not readable from Doppler milo/dev');
  const extractor = geminiExtractor({ apiKey: apiKey! });

  if (values['extract-only']) {
    const { mimeType, sizeBytes } = await assertLocalMedia(file);
    const e = normalizeExtraction(await extractor({ path: file, mimeType, sizeBytes, sha256: await hashFile(file) }, REEL_PROMPT, model));
    console.log(JSON.stringify({ model, steps: e.steps.length, unclear_steps: e.unclear_steps.length }));
    return;
  }

  const url = secret('hackathon', 'dev', 'SUPABASE_DB_URL') ?? blocked('SUPABASE_DB_URL missing from Doppler hackathon/dev');
  const client = new pg.Client({ connectionString: url! });
  await client.connect();
  try {
    const r = await importReel({ filePath: file, db: client, extractor, model });
    console.log(JSON.stringify({ technique_id: r.technique_id, status: 'proposed', cached: r.cached, model: r.model, media_sha256: r.media_sha256, steps: r.extraction.steps.length, unclear_steps: r.extraction.unclear_steps.length }));
  } finally { await client.end(); }
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
