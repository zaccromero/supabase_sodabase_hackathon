import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('../supabase/migrations/001_core.sql', import.meta.url), 'utf8');
let db: PGlite;
const one = async <T = any>(q: string, p: unknown[] = []) => (await db.query<T>(q, p)).rows[0];
const as = async <T>(role: string, fn: () => Promise<T>) => {
  await db.exec(`set role ${role}`);
  try { return await fn(); } finally { await db.exec('reset role'); }
};

async function seedRun() {
  const run = await one<{ id: string }>(`insert into cm.runs (profile, task, status) values ('gym_operator','q','running') returning id`);
  const c = await one<{ id: string }>(`insert into cm.check_contracts (run_id) values ($1) returning id`, [run!.id]);
  await db.query(`insert into cm.contract_checks (contract_id, check_id, kind) values ($1,'canonical_definition','deterministic')`, [c!.id]);
  await db.query(`update cm.check_contracts set contract_sha256='csha', frozen_at=now() where id=$1`, [c!.id]);
  const a = await one<{ id: string }>(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,1,'initial') returning id`, [run!.id, c!.id]);
  return { run: run!.id, contract: c!.id, attempt: a!.id };
}
const addOutput = async (attempt: string, sha = 'osha') =>
  (await as('agent_worker', () => one<{ id: string }>(`insert into cm.outputs (attempt_id, body, output_sha256) values ($1,'{"answer":1}',$2) returning id`, [attempt, sha])))!.id;
const addEvidence = async (output: string) =>
  (await as('evaluator_service', () => one<{ id: string }>(`insert into cm.evidence (output_id, kind, created_by) values ($1,'sql_result','evaluator') returning id`, [output])))!.id;
const addEval = (s: { run: string; contract: string; attempt: string }, output: string, verdict: string, evidence: string | null, sha = 'osha') =>
  as('evaluator_service', () => one<{ id: string }>(
    `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason, evidence_id)
     values ($1,$2,$3,$4,'canonical_definition',$5,'csha','det','1',$6,'r',$7) returning id`, [s.run, s.attempt, output, s.contract, sha, verdict, evidence]));
const complete = (run: string) => as('gate_service', () => one<{ r: any }>(`select cm.request_completion($1) r`, [run]));

beforeEach(async () => { db = new PGlite(); await db.exec(sql); });

describe('completion gate', () => {
  it('rejects completion with no output', async () => {
    const s = await seedRun();
    const res = await complete(s.run);
    expect(res!.r.verdict).toBe('blocked');
    expect(res!.r.missing[0].reason).toBe('NO_OUTPUT');
    await expect(db.query(`update cm.runs set status='completed' where id=$1`, [s.run])).rejects.toThrow(/GATE_REJECTED/);
  });

  it('rejects completion when a passing evaluation has no evidence', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    await addEval(s, o, 'pass', null);
    expect((await complete(s.run))!.r.missing[0].reason).toBe('NO_CURRENT_EVIDENCE');
  });

  it('completes with a current pass and evidence', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    await addEval(s, o, 'pass', await addEvidence(o));
    expect((await complete(s.run))!.r.verdict).toBe('completed');
    expect((await one<{ status: string }>(`select status from cm.runs where id=$1`, [s.run]))!.status).toBe('completed');
  });

  it('a pass on an earlier attempt does not count after a repair attempt', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    await addEval(s, o, 'pass', await addEvidence(o));
    await db.query(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,2,'repair')`, [s.run, s.contract]);
    expect((await complete(s.run))!.r.missing[0].reason).toBe('NO_OUTPUT');
  });

  it('rejects an evaluation whose output hash does not match', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    await expect(addEval(s, o, 'pass', null, 'stale')).rejects.toThrow(/BINDING_OUTPUT_HASH_MISMATCH/);
  });

  it('routes uncertain to founder approval, then completes on approval', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    const e = await addEval(s, o, 'uncertain', await addEvidence(o));
    expect((await complete(s.run))!.r.verdict).toBe('awaiting_approval');
    await as('founder_approver', () => db.query(`insert into cm.approvals (evaluation_id, decision, approver) values ($1,'approved','zacc')`, [e!.id]));
    expect((await complete(s.run))!.r.verdict).toBe('completed');
  });

  it('enforces the repair budget', async () => {
    const s = await seedRun();
    for (const n of [2, 3]) await db.query(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,$3,'repair')`, [s.run, s.contract, n]);
    await expect(db.query(`insert into cm.attempts (run_id, contract_id, attempt_no, kind) values ($1,$2,4,'repair')`, [s.run, s.contract])).rejects.toThrow(/REPAIR_BUDGET_EXHAUSTED/);
  });
});

describe('worker boundary', () => {
  it('worker cannot write evaluations, complete a run, call the gate, or accept a decision', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    await expect(as('agent_worker', () => db.query(
      `insert into cm.evaluations (run_id, attempt_id, output_id, contract_id, check_id, output_sha256, contract_sha256, evaluator, evaluator_version, verdict, reason)
       values ($1,$2,$3,$4,'canonical_definition','osha','csha','me','1','pass','self')`, [s.run, s.attempt, o, s.contract]))).rejects.toThrow(/permission denied/);
    await expect(as('agent_worker', () => db.query(`update cm.runs set status='completed' where id=$1`, [s.run]))).rejects.toThrow(/permission denied/);
    await expect(as('agent_worker', () => db.query(`select cm.request_completion($1)`, [s.run]))).rejects.toThrow(/permission denied/);
    await expect(as('agent_worker', () => db.query(`update cm.decisions set status='accepted'`))).rejects.toThrow(/permission denied/);
  });

  it('frozen contracts and evaluations are immutable', async () => {
    const s = await seedRun();
    const o = await addOutput(s.attempt);
    const e = await addEval(s, o, 'fail', await addEvidence(o));
    await expect(db.query(`insert into cm.contract_checks (contract_id, check_id, kind) values ($1,'x','critic')`, [s.contract])).rejects.toThrow(/CONTRACT_FROZEN/);
    await expect(db.query(`update cm.evaluations set verdict='pass' where id=$1`, [e!.id])).rejects.toThrow(/APPEND_ONLY/);
  });
});

describe('decision authority', () => {
  it('services cannot accept a decision, the founder can', async () => {
    const s = await one<{ id: string }>(`insert into cm.sources (kind, uri, title) values ('owner_note','chat','t') returning id`);
    await expect(as('gate_service', () => db.query(
      `insert into cm.decisions (decision_key, statement, scope, status, source_id, proposed_by, accepted_by, accepted_at)
       values ('k','s','{milo_pitch}','accepted',$1,'agent','agent',now())`, [s!.id]))).rejects.toThrow(/ONLY_FOUNDER_ACCEPTS/);
    const d = await as('gate_service', () => one<{ id: string }>(
      `insert into cm.decisions (decision_key, statement, scope, source_id, proposed_by) values ('k','s','{milo_pitch}',$1,'agent') returning id`, [s!.id]));
    await as('founder_approver', () => db.query(`update cm.decisions set status='accepted', accepted_by='zacc', accepted_at=now() where id=$1`, [d!.id]));
    expect((await one<{ status: string }>(`select status from cm.decisions where id=$1`, [d!.id]))!.status).toBe('accepted');
  });
});
