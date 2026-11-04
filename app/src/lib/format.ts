const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export const et = (d: Date | string) => `${clock.format(new Date(d))} ET`;

export function ago(d: Date | string, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(d).getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export const short = (hash: string | null | undefined, n = 10) => (hash ? hash.slice(0, n) : 'none');

const PROFILE: Record<string, string> = {
  gym_operator: 'Gym operator',
  milo_pitch: 'Milo pitch',
  drift_reviewer: 'Drift reviewer',
};
export const profileName = (p: string) => PROFILE[p] ?? p;

const REASON: Record<string, string> = {
  CONTRACT_NOT_FROZEN: 'contract not frozen',
  NO_ATTEMPT: 'no attempt',
  NO_OUTPUT: 'no output',
  NO_CURRENT_EVALUATION: 'no current evaluation',
  NO_CURRENT_EVIDENCE: 'no current evidence',
  FAILED: 'failed',
  NEEDS_FOUNDER_APPROVAL: 'needs founder approval',
};
export const reasonText = (r: string) => REASON[r] ?? r;
