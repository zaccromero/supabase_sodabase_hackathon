// Imports the six approved decisions into the database at SUPABASE_DB_URL, in one transaction.
import { pgDb } from '../src/runner/db';
import { importApproved } from './import-approved';

const db = pgDb();
await db.withRole('dashboard_reader', async (tx) => {
  await importApproved({
    exec: (sql) => tx.query(sql === 'reset role' ? 'set local role dashboard_reader' : sql),
    query: async (sql, params) => ({ rows: await tx.query(sql, params) }),
  });
});
const rows = await db.withRole('dashboard_reader', (tx) => tx.query('select decision_key, version, status, accepted_by from cm.decisions order by 1'));
console.log(JSON.stringify(rows));
await db.close();
process.exit(0);
