import type { ActionState } from '@/app/actions';
import { FounderButton } from '@/components/FounderButton';
import { founderWritesAllowed } from '@/lib/db';

// On a read-only page the control is not sent at all: no button, no label, no action id.
export function FounderAction({ action, id, label }: {
  action: (state: ActionState, form: FormData) => Promise<ActionState>;
  id: string;
  label: string;
}) {
  if (!founderWritesAllowed()) return <p className="not-yet">Waiting on the founder. This hosted page is read-only.</p>;
  return <FounderButton action={action} id={id} label={label} />;
}
