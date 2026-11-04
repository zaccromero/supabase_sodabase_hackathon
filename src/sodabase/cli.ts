// Run under Doppler so the token stays out of the shell:
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts status
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts probe
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts scan
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts pull --rules
// pull writes to cm.quality_findings when SUPABASE_DB_URL is set, and always writes a dated receipt on a ready connection.
import { pgDb } from '../runner/db.js';
import { SodabaseClient, SODABASE_PROJECT_REF } from './client.js';
import { pullFindings } from './pull.js';
import { sanitize } from './sanitize.js';

const [command = 'status', ...flags] = process.argv.slice(2);
const client = new SodabaseClient();

if (command === 'status') {
  const status = await client.connect();
  console.log(JSON.stringify({ ...status, project_ref: SODABASE_PROJECT_REF, project_listed: status.state === 'ready' ? await client.verifyProject() : null }, null, 2));
  await client.close();
} else if (command === 'probe') {
  // Read-only: tool discovery and data_trust_health, bound to the event project. No database.
  const result = await pullFindings(client, { healthOnly: true });
  console.log(JSON.stringify({ state: result.status.state, reason: result.status.reason, provenance: result.provenance, project_ref: SODABASE_PROJECT_REF, tools: result.status.tools, catalog: result.status.catalog, quality_evidence: result.quality_evidence, counts: result.counts, receipt: result.receipt_path }, null, 2));
  if (result.status.state !== 'ready') process.exitCode = 3;
} else if (command === 'scan') {
  const status = await client.connect();
  if (status.state !== 'ready' || !(await client.verifyProject())) { console.log(JSON.stringify({ ...status, project_ref: SODABASE_PROJECT_REF }, null, 2)); process.exitCode = 3; }
  else console.log(JSON.stringify(sanitize(await client.startScan()), null, 2));
  await client.close();
} else if (command === 'pull') {
  // Lane 1's connection, so TLS follows the URL and SUPABASE_DB_CA, and every write runs under evaluator_service.
  const url = process.env.SUPABASE_DB_URL;
  if (url && !url.includes(SODABASE_PROJECT_REF)) {
    console.error(`SUPABASE_DB_URL does not point at project ${SODABASE_PROJECT_REF}. Nothing was read or written.`);
    process.exit(3);
  }
  const db = url ? pgDb(url) : null;
  const asEvaluator = db && { query: (text: string, params?: unknown[]) => db.withRole('evaluator_service', async (tx) => ({ rows: await tx.query(text, params) })) };
  const result = await pullFindings(client, { ...(asEvaluator ? { db: asEvaluator } : {}), runRules: flags.includes('--rules') });
  console.log(JSON.stringify({ state: result.status.state, reason: result.status.reason, provenance: result.provenance, project_ref: SODABASE_PROJECT_REF, quality_evidence: result.quality_evidence, counts: result.counts, inserted: result.inserted, database_error: result.database_error, receipt: result.receipt_path, database: db ? 'SUPABASE_DB_URL set' : 'SUPABASE_DB_URL absent' }, null, 2));
  if (result.status.state !== 'ready' || result.database_error) process.exitCode = 3;
  process.exit();
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 2;
}
