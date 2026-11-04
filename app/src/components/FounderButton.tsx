'use client';
import { useActionState } from 'react';
import type { ActionState } from '@/app/actions';

export function FounderButton({ action, id, label, readOnly }: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  id: string;
  label: string;
  readOnly: boolean;
}) {
  const [state, run, pending] = useActionState(action, {} as ActionState);
  if (readOnly) return <p className="not-yet">Waiting on the founder. This hosted page is read-only.</p>;
  return (
    <form action={run} className="founder">
      <input type="hidden" name="id" value={id} />
      <button type="submit" disabled={pending}>{pending ? 'Writing…' : label}</button>
      {state.error ? <p role="alert" className="founder-error">{state.error}</p> : null}
    </form>
  );
}
