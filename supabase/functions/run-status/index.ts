// GET /functions/v1/run-status?run_id=<uuid>
// Schema cm is not exposed through PostgREST, so this reads over SUPABASE_DB_URL, which Supabase provides
// to functions and which never reaches a response. Each read is one READ ONLY transaction as dashboard_reader.
// Deploy: supabase functions deploy run-status --project-ref dgqcanfiapxztmqqlqnh
import postgres from 'npm:postgres@3.4.5';
import { createHandler, READ_ROLE, STATEMENT_TIMEOUT, STATUS_SQL, type StatusRow } from './handler.ts';

// One connection per isolate, reused across requests. prepare:false is required behind the transaction pooler.
const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { prepare: false, max: 1, idle_timeout: 20, connect_timeout: 5 });

Deno.serve(createHandler((runId) => sql.begin('read only', async (tx) => {
  await tx.unsafe(`set local role ${READ_ROLE}`);
  await tx.unsafe(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
  const rows = await tx.unsafe(STATUS_SQL, [runId]);
  return rows[0] as unknown as StatusRow | undefined;
})));
