#!/usr/bin/env tsx
// pnpm tsx src/reel/cli.ts --file /absolute/path/to/owner-reel.mp4
//   Hashes the file, reuses the cache or asks Hermes, stores a proposed technique in hosted Supabase.
// pnpm tsx src/reel/cli.ts --file ... --extract-only
//   Asks Hermes and prints the shape of the result. Touches no database.
// Analysis uses the owner's Hermes subscription. No model API key is read.
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { normalizeExtraction, REEL_PROMPT } from './extract';
import { hermesExtractor, hermesModelId } from './hermes';
import { assertLocalMedia, hashFile, importReel } from './import';

const secret = (name: string) => {
  try { return execFileSync('doppler', ['--no-check-version', 'secrets', 'get', name, '--plain', '-p', 'hackathon', '-c', 'dev'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; }
};
const blocked = (what: string): never => { console.error(`BLOCKED: ${what}`); process.exit(2); };

async function main() {
  const { values } = parseArgs({ options: { file: { type: 'string' }, 'extract-only': { type: 'boolean' } } });
  const file = values.file ?? blocked('--file is required: an owner-supplied local video');
  const model = hermesModelId();
  const extractor = hermesExtractor();

  if (values['extract-only']) {
    const { mimeType, sizeBytes } = await assertLocalMedia(file);
    const e = normalizeExtraction(await extractor({ path: file, mimeType, sizeBytes, sha256: await hashFile(file) }, REEL_PROMPT, model));
    console.log(JSON.stringify({ model, steps: e.steps.length, unclear_steps: e.unclear_steps.length }));
    return;
  }

  const url = secret('SUPABASE_DB_URL') ?? blocked('SUPABASE_DB_URL missing from Doppler hackathon/dev');
  const ca = secret('SUPABASE_DB_CA');
  // pg lets sslmode in the URL override the ssl option, so drop it when a CA is pinned. Verification stays on.
  const target = new URL(url);
  if (ca) target.searchParams.delete('sslmode');
  const client = new pg.Client({ connectionString: target.toString(), ...(ca ? { ssl: { ca } } : {}) });
  await client.connect();
  try {
    const r = await importReel({ filePath: file, db: client, extractor, model });
    console.log(JSON.stringify({ technique_id: r.technique_id, status: 'proposed', cached: r.cached, model: r.model, media_sha256: r.media_sha256, steps: r.extraction.steps.length, unclear_steps: r.extraction.unclear_steps.length }));
  } finally { await client.end(); }
}

main().catch((e) => { console.error(String(e?.message ?? e).slice(0, 200)); process.exit(1); });
