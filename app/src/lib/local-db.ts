// In-process PGlite built from the real migrations. Used only when SUPABASE_DB_URL
// is absent, and always labeled "local test database" on screen.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { writeLocalTestRows } from './local-test-rows';

const globals = globalThis as unknown as { __cmLocal?: Promise<PGlite> };

function migrationsDir(): string {
  for (const base of [process.cwd(), join(process.cwd(), '..')]) {
    const dir = join(base, 'supabase', 'migrations');
    if (existsSync(dir)) return dir;
  }
  throw new Error('supabase/migrations not found from the working directory');
}

async function boot(): Promise<PGlite> {
  const db = new PGlite();
  const dir = migrationsDir();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, file), 'utf8'));
  }
  // LOCAL_DB_ROWS=none leaves only the schema, to inspect the empty states.
  if (process.env.LOCAL_DB_ROWS !== 'none') await writeLocalTestRows(db);
  return db;
}

export function localDatabase(): Promise<PGlite> {
  globals.__cmLocal ??= boot().catch((error) => {
    globals.__cmLocal = undefined;
    throw error;
  });
  return globals.__cmLocal;
}
