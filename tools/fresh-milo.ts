// One real run: a new process retrieves accepted memory from the database at SUPABASE_DB_URL, generates through
// Hermes OAuth, is evaluated independently, and the database gate decides. No fallback, no auto-approval.
// doppler run -p hackathon -c dev -- tsx tools/fresh-milo.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHandlers } from '../src/agents/index';
import { checksFor, createStoredRegistry, guarded } from '../src/evaluators/index';
import { createCriticEvaluator } from '../src/evaluators/critic';
import { withHermesCritic, withHermesGeneration } from '../src/governance-demo/hermes-transport';
import { retrieveAccepted } from '../src/memory/index';
import { pgDb } from '../src/runner/db';
import { runAgent } from '../src/runner/run';

const root = new URL('..', import.meta.url).pathname;
const db = pgDb();
const handler = withHermesGeneration((client) => createHandlers({ model: () => client, slidePacketPath: `${root}data/curated/milo-slide-text.json` }).milo_pitch);
const critic = withHermesCritic((transport) => guarded(createCriticEvaluator({ transport: { ...transport, model: 'hermes_served_model_in_receipt' }, criticTimeoutMs: 120_000 }), 'critic.meaning'));
const binding = {
  handler,
  checks: (d: any) => checksFor('milo_pitch', d),
  evaluators: { ...createStoredRegistry(db as any), 'critic.meaning': critic },
};
const task = 'Revise this slide excerpt for the current pitch. Return only the title and body. No financial figures or usage claims.';
const started = new Date().toISOString();
const accepted = await retrieveAccepted(db, 'milo_pitch');
const report = await runAgent(db, { profile: 'milo_pitch', task, binding });
const q = (sql: string) => db.withRole('dashboard_reader', (tx) => tx.query<any>(sql, [report.run_id]));
const receipt = {
  environment: 'hosted Supabase, project dgqcanfiapxztmqqlqnh',
  transport: 'hermes_oauth',
  source_head: execSync('git rev-parse HEAD', { cwd: root }).toString().trim(),
  started, finished: new Date().toISOString(),
  accepted_for_profile: accepted.map((d) => `${d.decision_key}@${d.version}`),
  run_id: report.run_id, status: report.status, contract_sha256: report.contract_sha256,
  pinned: await q(`select d.id, d.decision_key, d.version, d.status, d.accepted_at, rd.pinned_at from cm.run_decisions rd join cm.decisions d on d.id = rd.decision_id where rd.run_id = $1 order by 2`),
  outputs: await q(`select o.id, a.attempt_no, a.kind, o.output_sha256, o.body from cm.outputs o join cm.attempts a on a.id = o.attempt_id where a.run_id = $1 order by 2`),
  evidence: await q(`select e.id, e.output_id, e.kind, e.sha256, e.payload, e.created_by from cm.evidence e join cm.outputs o on o.id = e.output_id join cm.attempts a on a.id = o.attempt_id where a.run_id = $1 order by e.created_at`),
  evaluations: await q(`select id, attempt_id, output_id, check_id, verdict, reason, evaluator, evaluator_version, evidence_id, output_sha256, contract_sha256 from cm.evaluations where run_id = $1 order by created_at`),
  gate_decisions: await q(`select verdict, missing, attempt_id, created_at from cm.gate_decisions where run_id = $1 order by created_at`),
};
mkdirSync(`${root}docs/receipts`, { recursive: true });
const path = `${root}docs/receipts/fresh-milo-hermes-${started.replace(/[:.]/g, '-')}.json`;
writeFileSync(path, JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ path, run_id: report.run_id, status: report.status, pinned: receipt.pinned.length, attempts: receipt.outputs.length, gate: report.gate?.verdict, failure: report.failure_reason }, null, 2));
process.exit(0);
