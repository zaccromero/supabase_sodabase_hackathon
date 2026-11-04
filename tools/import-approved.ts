// Imports the exact six owner-approved decisions. Refuses any byte difference from the approved packet.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface Tx {
  exec(sql: string): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
const FIELDS = ['id', 'decision_key', 'version', 'statement', 'source_id'] as const;

export function loadApprovedPacket(root = new URL('..', import.meta.url).pathname) {
  const bytes = readFileSync(`${root}data/curated/import.contract.json`);
  const approval = JSON.parse(readFileSync(`${root}docs/sources/owner-approval.json`, 'utf8'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== approval.approved_packet_sha256) throw new Error('APPROVED_PACKET_HASH_MISMATCH');
  const bundle = JSON.parse(bytes.toString());
  if (bundle.decisions.length !== 6 || approval.approved_decisions.length !== 6) throw new Error('APPROVED_COUNT_MISMATCH');
  for (const d of bundle.decisions) {
    const a = approval.approved_decisions.find((x: any) => x.id === d.id);
    for (const f of FIELDS) if (!a || a[f] !== d[f]) throw new Error(`APPROVED_VERSION_MISMATCH:${d.decision_key}:${f}`);
    if (d.status !== 'proposed') throw new Error('BUNDLE_MUST_START_PROPOSED');
  }
  return { bundle, approval, hash };
}

/** Run inside one transaction. Services insert as proposed; only founder_approver accepts. */
export async function importApproved(tx: Tx, packet = loadApprovedPacket()) {
  const { bundle, approval } = packet;
  await tx.exec('set local role gate_service');
  for (const [table, rows] of [['sources', bundle.sources], ['decisions', bundle.decisions]] as const) {
    for (const row of rows as Record<string, unknown>[]) {
      const cols = Object.keys(row);
      if (cols.some((c) => !/^\w+$/.test(c))) throw new Error('INVALID_COLUMN');
      const params = cols.map((_, i) => `$${i + 1}`).join(',');
      await tx.query(`insert into cm.${table} (${cols.join(',')}) values (${params}) on conflict (id) do nothing`, Object.values(row));
    }
  }
  await tx.exec('set local role founder_approver');
  for (const d of bundle.decisions) {
    const { rows } = await tx.query('select id, decision_key, version, statement, source_id, status from cm.decisions where id = $1', [d.id]);
    for (const f of FIELDS) if (!rows[0] || rows[0][f] !== d[f]) throw new Error(`EXISTING_DECISION_DIFFERS:${d.decision_key}`);
    await tx.query(`update cm.decisions set status = 'accepted', accepted_by = $2, accepted_at = now(), owner_approved_at = $3 where id = $1 and status = 'proposed'`, [d.id, approval.approver, approval.recorded_at]);
  }
  await tx.exec('reset role');
  return bundle.decisions.length as number;
}
