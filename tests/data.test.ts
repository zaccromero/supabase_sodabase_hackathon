import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  assertManifestSafe, hmacId, loadManifest, orderedTables, runMirror, selectSql, transformRow, verifyTarget,
  type RawRow, type RowSource, type TableSpec,
} from '../src/data/mirror-core';

const core = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
const gym = readFileSync(new URL('../supabase/migrations/002_gym.sql', import.meta.url), 'utf8');
const m = loadManifest();
const spec = (t: string) => m.tables.find((x) => x.table === t) as TableSpec;
const P = 'test-pepper';

const allNull = (t: string): RawRow => Object.fromEntries(Object.keys(spec(t).columns).map((c) => [c, null]));
const LOC = { ...allNull('locations'), id: 'lex', created_at: '2026-01-01 00:00:00+00' };
const M1 = '00000000-0000-4000-8000-000000000001';
const MEMBER = { ...allNull('members'), id: M1, ezf_client_id: '12345', ezf_membership_number: 'A-77', location_id: 'lex', joined_at: '2025-03-04 05:06:07.123+00', is_modification_cancel: 'false' };
const CHECKIN = { ...allNull('checkins'), id: '00000000-0000-4000-8000-0000000000c1', member_id: M1, location_id: 'lex', checked_in_at: '2026-10-01 12:00:00+00', ezf_checkin_id: 'lex-12345-2026-10-01', source: 'ezfacility' };
const AM = (id: string, key: string) => ({ ...allNull('ezf_active_memberships'), id, location_id: 'lex', source_membership_key: key, ezf_membership_number: 'A-77', member_id: M1, membership_mode: 'recurring', membership_start: '2026-01-01', membership_end: '2026-12-31', bridge_class: 'MATCHED_INDIVIDUAL', report_as_of: '2026-10-05', source_csv_sha256: 'c'.repeat(64), source_last_seen_at: '2026-10-05 08:00:00+00', ingested_at: '2026-10-05 08:00:00+00', updated_at: '2026-10-05 08:00:00+00' });
const FIN = (d: string, mrr: string) => ({ snapshot_date: d, location_id: 'all', recurring_mrr_cents: mrr, committed_mrr_cents: '2', fee_unknown_count: '0', active_members: '1', churned_members_total: '0', ar_total_cents: '0', ar_source: 'ar_invoices', flagged: null, computed_at: '2026-10-04 04:00:00+00' });

const sourceOf = (data: Record<string, RawRow[]>): RowSource => async function* (s) { const r = data[s.table] ?? []; if (r.length) yield r; };

describe('manifest allowlist', () => {
  it('has no column matching the PII pattern', () => {
    const banned = /name|email|phone|raw_|description|detail|message/;
    const hits = m.tables.flatMap((t) => Object.keys(t.columns).filter((c) => banned.test(c)).map((c) => `${t.table}.${c}`));
    expect(hits).toEqual([]);
    expect(() => assertManifestSafe(m)).not.toThrow();
  });
  it('rejects a manifest that adds a PII column', () => {
    const bad = { ...m, tables: [{ ...spec('locations'), columns: { ...spec('locations').columns, display_name: { type: 'text' as const } } }] };
    expect(() => assertManifestSafe(bad)).toThrow(/MANIFEST_FORBIDDEN_COLUMN/);
  });
  it('never selects the identifying or free-text source columns', () => {
    const never: Record<string, string[]> = {
      locations: ['name', 'address', 'ghl_location_id'],
      members: ['name', 'email', 'phone', 'raw_ezf_data', 'stripe_customer_id', 'source_lead_id', 'per_term_fee_cents', 'monthly_fee_cents_real', 'last_reactivation_sent'],
      ezf_active_memberships: ['source_row_sha256', 'membership_type_raw'],
      ezf_active_membership_sync_runs: ['upstream_location_id'],
    };
    for (const [t, cols] of Object.entries(never)) {
      for (const c of cols) {
        expect(spec(t).columns[c]).toBeUndefined();
        expect(selectSql(spec(t), 'public')).not.toContain(`"${c}"`);
      }
    }
  });
  it('hashes exactly the identifiers that join or embed a client id', () => {
    const hashed = m.tables.flatMap((t) => Object.entries(t.columns).filter(([, c]) => c.hash).map(([c]) => `${t.table}.${c}`)).sort();
    expect(hashed).toEqual([
      'checkins.ezf_checkin_id', 'ezf_active_memberships.ezf_membership_number', 'ezf_active_memberships.source_membership_key',
      'members.ezf_client_id', 'members.ezf_membership_number',
    ]);
  });
  it('declares the finance composite key and the only full-replace table', () => {
    expect(spec('finance_snapshots').key).toEqual(['snapshot_date', 'location_id']);
    expect(m.tables.filter((t) => t.mode === 'full_replace').map((t) => t.table)).toEqual(['ezf_active_memberships']);
  });
  it('reads from dev only and limits check-ins to six months', () => {
    expect(m.source.doppler_config).toBe('dev');
    expect(spec('checkins').where).toContain(`interval '6 months'`);
  });
});

describe('transformRow', () => {
  it('hashes with one pepper, so joins survive across tables', () => {
    const a = transformRow(spec('members'), MEMBER, P);
    const b = transformRow(spec('ezf_active_memberships'), AM('00000000-0000-4000-8000-0000000000a1', 'k1'), P);
    expect(a.ezf_membership_number).toBe(hmacId(P, 'A-77'));
    expect(a.ezf_membership_number).toBe(b.ezf_membership_number);
    expect(a.ezf_client_id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(a)).not.toContain('12345');
  });
  it('changes every hash when the pepper changes', () => {
    expect(hmacId('p1', 'x')).not.toBe(hmacId('p2', 'x'));
  });
  it('drops columns not in the allowlist even when the source sends them', () => {
    const out = transformRow(spec('members'), { ...MEMBER, name: 'x', email: 'a@b.co', phone: '2125551212', raw_ezf_data: '{}' }, P);
    for (const c of ['name', 'email', 'phone', 'raw_ezf_data']) expect(out).not.toHaveProperty(c);
  });
  it('keeps source timestamps verbatim and nulls as nulls', () => {
    const out = transformRow(spec('members'), { ...MEMBER, ezf_membership_number: null }, P);
    expect(out.joined_at).toBe('2025-03-04 05:06:07.123+00');
    expect(out.ezf_membership_number).toBeNull();
  });
  it('refuses email or phone shaped values and names only the column', () => {
    for (const v of ['someone@example.com', '(212) 555-1212', '+1 212 555 1212']) {
      let err = '';
      try { transformRow(spec('members'), { ...MEMBER, membership_type: v }, P); } catch (e) { err = String(e); }
      expect(err).toContain('PII_VALUE_REFUSED: members.membership_type');
      expect(err).not.toContain(v);
    }
  });
  it('does not mistake a uuid or csv digest for a phone number', () => {
    expect(() => transformRow(spec('ezf_active_memberships'), AM('00000000-0000-4000-8000-0000000000a1', 'k'), P)).not.toThrow();
  });
  it('fails closed without a pepper or with a missing source column', () => {
    expect(() => transformRow(spec('members'), MEMBER, '')).toThrow(/MIRROR_PEPPER_MISSING/);
    const { joined_at: _omit, ...partial } = MEMBER;
    expect(() => transformRow(spec('members'), partial as RawRow, P)).toThrow(/SOURCE_COLUMN_MISSING/);
  });
});

describe('mirror against the gym DDL', () => {
  let db: PGlite;
  beforeEach(async () => { db = new PGlite(); await db.exec(core); await db.exec(gym); });
  const data = () => ({
    locations: [LOC], members: [MEMBER], checkins: [CHECKIN],
    ezf_active_memberships: [AM('00000000-0000-4000-8000-0000000000a1', 'k1'), AM('00000000-0000-4000-8000-0000000000a2', 'k2')],
    finance_snapshots: [FIN('2026-10-03', '100'), FIN('2026-10-04', '200')],
  });
  const n = async (t: string) => (await db.query<{ n: number }>(`select count(*)::int n from gym.${t}`)).rows[0]!.n;

  it('creates exactly the allowlisted columns', async () => {
    for (const t of orderedTables(m)) {
      const r = await db.query<{ column_name: string; udt_name: string }>(`select column_name, udt_name from information_schema.columns where table_schema='gym' and table_name=$1`, [t.table]);
      expect(r.rows.map((x) => x.column_name).sort()).toEqual(Object.keys(t.columns).sort());
      for (const row of r.rows) expect(row.udt_name).toBe(t.columns[row.column_name]!.type);
    }
  });
  it('writes, verifies, keeps timestamps as the same instant', async () => {
    const { counts } = await runMirror(m, sourceOf(data()), db, P);
    expect(counts).toMatchObject({ members: 1, checkins: 1, ezf_active_memberships: 2, finance_snapshots: 2 });
    expect(await verifyTarget(m, db, counts)).toEqual([]);
    const r = await db.query<{ t: string }>(`select joined_at::text t from gym.members`);
    expect(new Date(r.rows[0]!.t).toISOString()).toBe('2025-03-04T05:06:07.123Z');
  });
  it('upserts on repeat, with the composite finance key', async () => {
    await runMirror(m, sourceOf(data()), db, P);
    const next = data();
    next.finance_snapshots = [FIN('2026-10-04', '999'), FIN('2026-10-05', '300')];
    await runMirror(m, sourceOf(next), db, P);
    expect(await n('finance_snapshots')).toBe(3);
    const r = await db.query<{ v: number }>(`select recurring_mrr_cents v from gym.finance_snapshots where snapshot_date='2026-10-04' and location_id='all'`);
    expect(r.rows[0]!.v).toBe(999);
  });
  it('fully replaces active memberships', async () => {
    await runMirror(m, sourceOf(data()), db, P);
    const next = data();
    next.ezf_active_memberships = [AM('00000000-0000-4000-8000-0000000000a3', 'k3')];
    await runMirror(m, sourceOf(next), db, P);
    const r = await db.query<{ id: string }>(`select id from gym.ezf_active_memberships`);
    expect(r.rows.map((x) => x.id)).toEqual(['00000000-0000-4000-8000-0000000000a3']);
  });
  it('refuses to wipe active memberships when the source is empty', async () => {
    await runMirror(m, sourceOf(data()), db, P);
    const next = data();
    next.ezf_active_memberships = [];
    await expect(runMirror(m, sourceOf(next), db, P)).rejects.toThrow(/FULL_REPLACE_EMPTY_SOURCE/);
    expect(await n('ezf_active_memberships')).toBe(2);
  });
  it('rejects a raw identifier at the database', async () => {
    await runMirror(m, sourceOf(data()), db, P);
    await expect(db.query(`update gym.members set ezf_client_id = '12345'`)).rejects.toThrow(/hmac_ezf_client_id/);
    await expect(db.query(`update gym.checkins set ezf_checkin_id = 'lex-12345-2026'`)).rejects.toThrow(/hmac_ezf_checkin_id/);
  });
  it('dry run shape writes nothing', async () => {
    const { counts } = await runMirror(m, sourceOf(data()), null, P);
    expect(counts.members).toBe(1);
    expect(await n('members')).toBe(0);
  });
  it('lets readers select and never write', async () => {
    await runMirror(m, sourceOf(data()), db, P);
    await db.exec('set role dashboard_reader');
    try {
      expect((await db.query(`select id from gym.members`)).rows.length).toBe(1);
      await expect(db.query(`delete from gym.members`)).rejects.toThrow(/permission denied/);
    } finally { await db.exec('reset role'); }
    await db.exec('set role agent_worker');
    try {
      expect((await db.query(`select id from gym.ezf_active_memberships`)).rows.length).toBe(2);
      await expect(db.query(`insert into gym.locations (id) values ('x')`)).rejects.toThrow(/permission denied/);
    } finally { await db.exec('reset role'); }
  });
});
