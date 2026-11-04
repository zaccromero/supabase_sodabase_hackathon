'use server';
// The only writes in this app. Both run as founder_approver, so the migration's
// grants and triggers still decide what is allowed.
import { revalidatePath } from 'next/cache';
import { withRole } from '@/lib/db';

export interface ActionState { error?: string; done?: string }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const founder = () => process.env.FOUNDER_NAME || 'Zacc Romero';

function explain(error: unknown): string {
  const code = (error as { code?: string }).code;
  if (code === 'HOSTED_READ_ONLY') return 'This hosted page is read-only.';
  if (code === '23505') return 'Another version of this decision is already accepted.';
  if (code === '42501') return 'The database refused this write for founder_approver.';
  return 'The write did not go through. Nothing changed.';
}

export async function acceptDecision(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  if (!UUID.test(id)) return { error: 'Not a decision id.' };
  try {
    // Same steps as acceptDecision in src/runner/fresh.ts, in one transaction: the accepted
    // version steps down, this one is accepted, and findings it corrects become corrected.
    const accepted = await withRole('founder_approver', async (tx) => {
      const [d] = await tx.query<{ decision_key: string }>(
        `select decision_key from cm.decisions where id = $1 and status = 'proposed'`, [id]);
      if (!d) return false;
      await tx.query(`update cm.decisions set status = 'superseded' where decision_key = $1 and status = 'accepted'`, [d.decision_key]);
      const rows = await tx.query(
        `update cm.decisions set status = 'accepted', accepted_by = $2, accepted_at = now() where id = $1 and status = 'proposed' returning id`,
        [id, founder()]);
      await tx.query(`update cm.findings set status = 'corrected' where correction_decision_id = $1 and status = 'open'`, [id]);
      return rows.length === 1;
    });
    revalidatePath('/app');
    return accepted ? { done: 'Accepted' } : { error: 'This decision is no longer proposed.' };
  } catch (error) {
    return { error: explain(error) };
  }
}

export async function approveEvaluation(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  if (!UUID.test(id)) return { error: 'Not an evaluation id.' };
  try {
    const approved = await withRole('founder_approver', async (tx) => {
      // Only the evaluation the gate would read: uncertain, on the run's latest attempt, newest for its check.
      const rows = await tx.query(
        `insert into cm.approvals (evaluation_id, decision, approver)
         select e.id, 'approved', $2 from cm.evaluations e
         where e.id = $1 and e.verdict = 'uncertain'
           and e.attempt_id = (select a.id from cm.attempts a where a.run_id = e.run_id order by a.attempt_no desc limit 1)
           and e.id = (select x.id from cm.evaluations x where x.attempt_id = e.attempt_id and x.check_id = e.check_id order by x.created_at desc, x.id desc limit 1)
         on conflict (evaluation_id) do nothing returning id`,
        [id, founder()]);
      return rows.length === 1;
    });
    revalidatePath('/app');
    return approved ? { done: 'Approved' } : { error: 'This evaluation can no longer be approved.' };
  } catch (error) {
    return { error: explain(error) };
  }
}
