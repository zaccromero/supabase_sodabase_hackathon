// Imports one owner-supplied local reel into cm.techniques as proposed.
// Local files only: no URL is ever fetched. A technique can never change a decision.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { Queryable } from '../data/mirror-core';
import { DEFAULT_MODEL, normalizeExtraction, promptSha256, REEL_PROMPT, type Extraction } from './extract';
import type { Extractor } from './gemini';

const MIME: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.avi': 'video/x-msvideo' };
const MAX_BYTES = 2 * 1024 * 1024 * 1024;

export interface ImportResult { technique_id: string; source_id: string; media_sha256: string; model: string; prompt_sha256: string; cached: boolean; extraction: Extraction; }

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

export async function assertLocalMedia(path: string): Promise<{ mimeType: string; sizeBytes: number }> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error('REEL_LOCAL_FILE_ONLY');
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile()) throw new Error('REEL_LOCAL_FILE_ONLY');
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) throw new Error('REEL_UNSUPPORTED_TYPE');
  if (st.size === 0 || st.size > MAX_BYTES) throw new Error('REEL_BAD_SIZE');
  return { mimeType, sizeBytes: st.size };
}

/** Every statement this module runs passes here. A reference to decisions is refused before it reaches the database. */
function guarded(db: Queryable): Queryable {
  return {
    query: (sql, params) => {
      if (/decisions/i.test(sql)) throw new Error('REEL_CANNOT_TOUCH_DECISIONS');
      return db.query(sql, params);
    },
  };
}

async function asGateService<T>(db: Queryable, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    await db.query('set local role gate_service');
    const r = await fn();
    await db.query('commit');
    return r;
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}

export async function importReel(input: { filePath: string; db: Queryable; extractor: Extractor; model?: string }): Promise<ImportResult> {
  const { mimeType, sizeBytes } = await assertLocalMedia(input.filePath);
  const db = guarded(input.db);
  const model = input.model ?? DEFAULT_MODEL;
  const media_sha256 = await hashFile(input.filePath);
  const prompt_sha256 = promptSha256();

  const lookup = () => db.query(
    `select id, source_id, extraction from cm.techniques where media_sha256 = $1 and model = $2 and prompt_sha256 = $3`,
    [media_sha256, model, prompt_sha256],
  );
  const hit = (await asGateService(db, lookup)).rows[0];
  if (hit) return { technique_id: hit.id, source_id: hit.source_id, media_sha256, model, prompt_sha256, cached: true, extraction: hit.extraction };

  // Outside any transaction: this call can take minutes.
  const extraction = normalizeExtraction(await input.extractor({ path: input.filePath, mimeType, sizeBytes, sha256: media_sha256 }, REEL_PROMPT, model));

  return asGateService(db, async () => {
    const uri = `reel:sha256:${media_sha256}`;
    const existing = await db.query(`select id from cm.sources where uri = $1`, [uri]);
    const source_id: string = existing.rows[0]?.id ?? (await db.query(
      `insert into cm.sources (kind, uri, title, content_sha256) values ('reel', $1, $2, $3) returning id`,
      [uri, `Owner-supplied reel ${media_sha256.slice(0, 12)}`, media_sha256],
    )).rows[0].id;
    const inserted = await db.query(
      `insert into cm.techniques (source_id, media_sha256, model, prompt_sha256, extraction, status)
       values ($1::uuid, $2, $3, $4, $5::text::jsonb, 'proposed')
       on conflict (media_sha256, model, prompt_sha256) do nothing returning id`,
      [source_id, media_sha256, model, prompt_sha256, JSON.stringify(extraction)],
    );
    if (inserted.rows[0]) return { technique_id: inserted.rows[0].id, source_id, media_sha256, model, prompt_sha256, cached: false, extraction };
    // Another import finished first, so its row stands.
    const row = (await lookup()).rows[0];
    return { technique_id: row.id, source_id: row.source_id, media_sha256, model, prompt_sha256, cached: true, extraction: row.extraction };
  });
}
