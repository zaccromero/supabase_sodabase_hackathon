// Real proof: approved decisions imported, a Milo run with no chat context retrieves and pins them,
// real model output is evaluated, and the database gate decides. Writes a receipt.
// MODEL_TRANSPORT=cli pnpm exec tsx tools/fresh-milo.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createHandlers } from '../src/agents/index';
import { checksFor, createStoredRegistry } from '../src/evaluators/index';
import { retrieveAccepted } from '../src/memory/index';
import { pgDb, pgliteDb } from '../src/runner/db';
import { runAgent, type RunReport } from '../src/runner/run';
import { importApproved, loadApprovedPacket } from './import-approved';

const root = new URL('..', import.meta.url).pathname;
const live = Boolean(process.env.SUPABASE_DB_URL);
const packet = loadApprovedPacket(root);
let db;
if (live) {
  db = pgDb();
} else {
  const pg = new PGlite();
  for (const f of readdirSync(`${root}supabase/migrations`).sort()) await pg.exec(readFileSync(`${root}supabase/migrations/${f}`, 'utf8').replace(/^grant .* to postgres;$/m, ''));
  db = pgliteDb(pg);
  await pg.transaction((tx) => importApproved(tx as any, packet));
}
const handlers = createHandlers({ slidePacketPath: `${root}data/curated/milo-slide-text.json` });
const binding = { handler: handlers.milo_pitch, evaluators: createStoredRegistry(db as any), checks: (d: any) => checksFor('milo_pitch', d) };
const task = 'Revise this slide excerpt for the current pitch. Return only the title and body. No financial figures or usage claims.';

const accepted = await retrieveAccepted(db, 'milo_pitch');
const started = new Date().toISOString();
const report: RunReport = await runAgent(db, { profile: 'milo_pitch', task, binding });
const q = (sql: string, p: unknown[]) => db.withRole('dashboard_reader', (tx: any) => tx.query(sql, p));
const pins: any = await q(`select d.decision_key, d.version, d.status from cm.run_decisions rd join cm.decisions d on d.id = rd.decision_id where rd.run_id = $1 order by 1`, [report.run_id]);
const gates: any = await q(`select verdict, missing, created_at from cm.gate_decisions where run_id = $1 order by created_at`, [report.run_id]);
const receipt = {
  environment: live ? 'SUPABASE_DB_URL' : 'local PGlite test database, not hosted Supabase',
  model_transport: process.env.MODEL_TRANSPORT ?? 'api',
  approved_packet_sha256: packet.hash, started, finished: new Date().toISOString(),
  accepted_for_profile: accepted.map((d) => `${d.decision_key}@${d.version}`),
  run_id: report.run_id, status: report.status, contract_sha256: report.contract_sha256,
  pinned: pins, attempts: report.attempts, gate_decisions: gates,
};
mkdirSync(`${root}docs/receipts`, { recursive: true });
const path = `${root}docs/receipts/fresh-milo-${started.replace(/[:.]/g, '-')}.json`;
writeFileSync(path, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ path, status: report.status, pinned: pins.length, attempts: report.attempts.length, gate: report.gate?.verdict }, null, 2));
process.exit(0);
