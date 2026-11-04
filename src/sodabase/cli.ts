// Run under Doppler so the token stays out of the shell:
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts status
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts scan
//   doppler run --project hackathon --config dev -- tsx src/sodabase/cli.ts pull --rules
// pull writes to cm.quality_findings when SUPABASE_DB_URL is set, and always writes a dated receipt on a ready connection.
import pg from 'pg';
import { SodabaseClient } from './client.js';
import { pullFindings } from './pull.js';
import { sanitize } from './sanitize.js';

const [command = 'status', ...flags] = process.argv.slice(2);
const client = new SodabaseClient();

if (command === 'status') {
  console.log(JSON.stringify(await client.connect(), null, 2));
  await client.close();
} else if (command === 'scan') {
  const status = await client.connect();
  if (status.state !== 'ready') { console.log(JSON.stringify(status, null, 2)); process.exitCode = 3; }
  else console.log(JSON.stringify(sanitize(await client.startScan()), null, 2));
  await client.close();
} else if (command === 'pull') {
  const url = process.env.SUPABASE_DB_URL;
  const db = url ? new pg.Client({ connectionString: url }) : null;
  if (db) { await db.connect(); await db.query('set role evaluator_service'); }
  try {
    const result = await pullFindings(client, { ...(db ? { db } : {}), runRules: flags.includes('--rules') });
    console.log(JSON.stringify({ state: result.status.state, reason: result.status.reason, provenance: result.provenance, counts: result.counts, inserted: result.inserted, receipt: result.receipt_path, database: db ? 'written' : 'SUPABASE_DB_URL absent' }, null, 2));
    if (result.status.state !== 'ready') process.exitCode = 3;
  } finally {
    await db?.end();
  }
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 2;
}
