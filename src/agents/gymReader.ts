// Read-only access to the pseudonymized `gym` mirror. Two independent layers:
// validateGymSql screens what the model asks for, and every statement runs inside a
// READ ONLY transaction that always rolls back, so Postgres itself rejects a write.
import pg from 'pg';

export interface SqlResult { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean; }
export interface GymReader {
  query(sql: string): Promise<SqlResult>;
  describeSchema(): Promise<Record<string, string[]>>;
}
/** Anything that can run one statement: a pg Client, or PGlite in tests. */
export type SqlExecutor = (text: string) => Promise<{ fields: Array<{ name: string }>; rows: unknown[] }>;

export const MAX_ROWS = 200;
const STATEMENT_TIMEOUT = '10s';

const IDENTIFYING_COLUMNS = ['email', 'phone', 'raw_ezf_data', 'stripe_customer_id', 'ezf_client_id', 'first_name', 'last_name', 'dob', 'date_of_birth', 'address'];
const FORBIDDEN_WORDS = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|set|reset|lock|vacuum|analyze|refresh|listen|notify|prepare|execute|begin|commit|rollback|savepoint|into)\b/i;
const FORBIDDEN_FUNCTIONS = /\b(pg_sleep\w*|pg_read\w*|pg_ls\w*|pg_terminate\w*|pg_cancel\w*|set_config|dblink\w*|lo_\w+|current_setting|\w+_to_xml\w*)\b/i;
const FOREIGN_SCHEMA = /\b(cm|public|auth|storage|extensions|information_schema|pg_catalog|pg_\w+|vault|realtime)\s*\./i;

/** Blanks strings and comments so keyword checks cannot be hidden in them or tripped by them. */
function codeOnly(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/"/g, '');
}

/** Returns the rejection reason, or null when the statement may run. */
export function validateGymSql(sql: string): string | null {
  const code = codeOnly(sql).trim().replace(/;\s*$/, '');
  if (!code) return 'Empty statement';
  if (code.includes(';')) return 'Only one statement is allowed';
  if (!/^(select|with)\b/i.test(code)) return 'Only SELECT or WITH statements are allowed';
  const word = code.match(FORBIDDEN_WORDS);
  if (word) return `Read-only tool: "${word[0]}" is not allowed`;
  const fn = code.match(FORBIDDEN_FUNCTIONS);
  if (fn) return `"${fn[0]}" is not allowed`;
  const schema = code.match(FOREIGN_SCHEMA);
  if (schema) return `Only schema gym is readable; found "${schema[0].trim()}"`;
  const identifying = IDENTIFYING_COLUMNS.find((column) => new RegExp(`\\b${column}\\b`, 'i').test(code));
  if (identifying) return `Identifying column "${identifying}" is not available to this tool`;
  return null;
}

async function inReadOnlyTransaction<T>(execute: SqlExecutor, work: () => Promise<T>): Promise<T> {
  await execute('begin transaction read only');
  try {
    await execute('set local search_path to gym');
    await execute(`set local statement_timeout = '${STATEMENT_TIMEOUT}'`);
    return await work();
  } finally {
    await execute('rollback');
  }
}

/** Builds a reader over one executor. The subquery wrap caps rows and rejects a smuggled second statement. */
export function readerFromExecutor(execute: SqlExecutor): GymReader {
  return {
    query: (sql) => inReadOnlyTransaction(execute, async () => {
      const body = sql.trim().replace(/;\s*$/, '');
      const result = await execute(`select * from (\n${body}\n) as gym_query limit ${MAX_ROWS + 1}`);
      const columns = result.fields.map((field) => field.name);
      const identifying = columns.find((column) => IDENTIFYING_COLUMNS.includes(column.toLowerCase()));
      if (identifying) throw new Error(`Identifying column "${identifying}" is not available to this tool`);
      const rows = result.rows as Record<string, unknown>[];
      return { columns, rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
    }),
    describeSchema: () => inReadOnlyTransaction(execute, async () => {
      const result = await execute(
        `select table_name, column_name from information_schema.columns where table_schema = 'gym' order by table_name, ordinal_position`,
      );
      const tables: Record<string, string[]> = {};
      for (const row of result.rows as Array<{ table_name: string; column_name: string }>) {
        if (IDENTIFYING_COLUMNS.includes(row.column_name.toLowerCase())) continue;
        (tables[row.table_name] ??= []).push(row.column_name);
      }
      return tables;
    }),
  };
}

// Dates and timestamps stay as Postgres text, so data_as_of is never shifted by the local timezone.
const RAW_TEXT_OIDS = new Set([1082, 1114, 1184]);
const rawDateTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (RAW_TEXT_OIDS.has(oid)) return (value: string) => value;
    return (pg.types.getTypeParser as (o: number, f?: string) => (value: string) => unknown)(oid, format ?? 'text');
  },
};

/**
 * The connection is held per reader call so nothing stays open between handler runs.
 * GYM_DATABASE_URL must point at the hackathon database holding the mirror; a generic
 * DATABASE_URL is deliberately not read, since other Doppler configs define it for company databases.
 */
export function pgGymReader(connectionString: string): GymReader {
  const connected = async <T>(use: (reader: GymReader) => Promise<T>): Promise<T> => {
    const client = new pg.Client({ connectionString, types: rawDateTypes as never });
    await client.connect();
    try {
      return await use(readerFromExecutor(async (text) => {
        const { fields, rows } = await client.query(text);
        return { fields, rows };
      }));
    } finally {
      await client.end();
    }
  };
  return {
    query: (sql) => connected((reader) => reader.query(sql)),
    describeSchema: () => connected((reader) => reader.describeSchema()),
  };
}

export function gymReaderFromEnv(): GymReader {
  const url = process.env.GYM_DATABASE_URL;
  if (!url) throw new Error('GYM_DATABASE_URL is not set: the gym mirror is unavailable');
  return pgGymReader(url);
}
