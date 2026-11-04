// Tiny database interface shared by PGlite (tests) and pg (Supabase).
// Every statement the runner issues goes through withRole, so the database's grants decide what it may do.
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { DbRole } from '../contract/types';

export interface Tx {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Switch role inside this transaction, for one atomic write that crosses a role boundary. */
  setRole(role: DbRole): Promise<void>;
}

export interface Db {
  /** Runs fn in one transaction under SET LOCAL ROLE. Do not nest: PGlite has a single connection. */
  withRole<T>(role: DbRole, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const ROLES: ReadonlySet<string> = new Set<DbRole>(['agent_worker', 'evaluator_service', 'gate_service', 'founder_approver', 'dashboard_reader']);

/** The role name is interpolated (SET has no bind parameters), so only the known roles get through. */
function setLocalRole(role: DbRole): string {
  if (!ROLES.has(role)) throw new Error(`UNKNOWN_ROLE: ${role}`);
  return `set local role ${role}`;
}

/** Wraps a PGlite instance. The caller owns its lifecycle unless it calls close(). */
export function pgliteDb(instance: PGlite): Db {
  return {
    withRole: async <T>(role: DbRole, fn: (tx: Tx) => Promise<T>) =>
      (await instance.transaction(async (raw) => {
        await raw.query(setLocalRole(role));
        return fn({
          query: async <R>(sql: string, params: unknown[] = []) => (await raw.query<R>(sql, params)).rows,
          setRole: async (next) => { await raw.query(setLocalRole(next)); },
        });
      })) as T,
    close: () => instance.close(),
  };
}

/**
 * pg settings for a connection string. A remote database needs TLS: either SUPABASE_DB_CA (the project's CA, which
 * is verified) or an sslmode in the URL. Without one, pg would send the password in the clear. The error never
 * includes the URL. pg lets sslmode in the URL override the ssl option, so it comes out when a CA is given.
 */
export function pgConfig(url = process.env.SUPABASE_DB_URL, ca = process.env.SUPABASE_DB_CA): pg.ClientConfig {
  if (!url) throw new Error('SUPABASE_DB_URL is not set. Run under: doppler run --project hackathon --config dev --');
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  if (ca) {
    parsed.searchParams.delete('sslmode');
    return { connectionString: parsed.toString(), ssl: { ca } };
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!local && (!sslmode || sslmode === 'disable')) throw new Error('TLS_REQUIRED: set SUPABASE_DB_CA, or add sslmode=verify-full to SUPABASE_DB_URL');
  return { connectionString: url };
}

/** Connects with SUPABASE_DB_URL (Doppler hackathon/dev). */
export function pgDb(url = process.env.SUPABASE_DB_URL): Db {
  const pool = new pg.Pool({ ...pgConfig(url), max: 5 });
  return {
    withRole: async <T>(role: DbRole, fn: (tx: Tx) => Promise<T>) => {
      const sql = setLocalRole(role);
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(sql);
        const result = await fn({
          query: async <R>(text: string, params: unknown[] = []) => (await client.query(text, params as any[])).rows as R[],
          setRole: async (next) => { await client.query(setLocalRole(next)); },
        });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
