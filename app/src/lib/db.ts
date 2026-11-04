// One door to the database. Every query runs inside a transaction under a named
// cm role (SET LOCAL ROLE), so the migration's grants decide what the app can do.
//
// The mode comes from the environment and nothing else: a failed live read is
// reported as a failure and never falls back to the local test database.
import { Pool } from 'pg';
import { localDatabase } from './local-db';

export type DbMode = 'live' | 'local';
export type AppRole = 'dashboard_reader' | 'founder_approver';

export interface Tx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export const dbMode = (): DbMode => (process.env.SUPABASE_DB_URL ? 'live' : 'local');

const globals = globalThis as unknown as { __cmPool?: Pool };

function livePool(): Pool {
  if (globals.__cmPool) return globals.__cmPool;
  const url = new URL(process.env.SUPABASE_DB_URL as string);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  // pg lets sslmode in the URL override the ssl object below, so the object decides.
  url.searchParams.delete('sslmode');
  const ca = process.env.SUPABASE_DB_CA;
  const pool = new Pool({
    connectionString: url.toString(),
    max: 4,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    // Certificates are always verified. If the server chains to a private CA, put
    // that CA in SUPABASE_DB_CA; until then the read fails and the page says so.
    ssl: local ? undefined : ca ? { ca } : true,
  });
  pool.on('error', () => {}); // An idle client dropping is not a page failure.
  globals.__cmPool = pool;
  return pool;
}

export async function withRole<T>(role: AppRole, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const readOnly = role === 'dashboard_reader';
  if (dbMode() === 'live') {
    const client = await livePool().connect();
    try {
      await client.query(readOnly ? 'begin read only' : 'begin');
      await client.query(`set local role ${role}`);
      await client.query(`set local statement_timeout = '5s'`);
      const result = await fn({
        query: async <R,>(sql: string, params: unknown[] = []) =>
          (await client.query(sql, params)).rows as R[],
      });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await localDatabase();
  return db.transaction(async (tx) => {
    if (readOnly) await tx.exec('set transaction read only');
    await tx.exec(`set local role ${role}`);
    return fn({
      query: async <R,>(sql: string, params: unknown[] = []) =>
        (await tx.query<R>(sql, params)).rows,
    });
  }) as Promise<T>;
}
