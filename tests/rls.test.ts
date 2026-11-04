import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

const dir = new URL('../supabase/migrations/', import.meta.url);
it('every cm and coord table has RLS, and an unlisted role reads nothing', async () => {
  const db = new PGlite();
  await db.exec('create role postgres_app nologin; create role soda_readonly_c68226d2fe1d nologin; create role anon_like nologin;');
  for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8').replace(/^grant .* to postgres;$/gm, ''));
  const off = await db.query<any>(`select tablename from pg_tables where schemaname in ('cm','coord') and not rowsecurity`);
  expect(off.rows).toEqual([]);
  await db.exec(`grant usage on schema cm to anon_like; grant select on cm.decisions to anon_like; insert into cm.sources (kind, uri, title) values ('owner_note','x','t');`);
  await db.exec(`insert into cm.decisions (decision_key, statement, scope, source_id, proposed_by) select 'k','s','{milo_pitch}',id,'a' from cm.sources`);
  await db.exec('set role anon_like');
  expect((await db.query('select * from cm.decisions')).rows).toHaveLength(0);
  await db.exec('reset role; set role dashboard_reader');
  expect((await db.query('select * from cm.decisions')).rows).toHaveLength(1);
});
