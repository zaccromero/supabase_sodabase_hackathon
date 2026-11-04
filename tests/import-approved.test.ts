import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { importApproved, loadApprovedPacket } from '../tools/import-approved';

const sql = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');

it('imports exactly the six approved decisions as accepted, idempotently', async () => {
  const db = new PGlite();
  await db.exec(sql);
  const packet = loadApprovedPacket();
  for (let i = 0; i < 2; i++) await db.transaction((tx) => importApproved(tx as any, packet));
  const { rows } = await db.query<any>('select decision_key, status, accepted_by from cm.decisions order by 1');
  expect(rows).toHaveLength(6);
  expect(rows.every((r) => r.status === 'accepted' && r.accepted_by === 'Zacc Romero')).toBe(true);
  expect(rows.map((r) => r.decision_key)).toContain('milo.gym_nyc_partner');
});
