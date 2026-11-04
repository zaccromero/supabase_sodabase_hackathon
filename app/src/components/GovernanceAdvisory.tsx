// Read-only advice about one stored run. It never calls a model or the gate, and it is
// not the gate: a run can be completed by the gate and still be on hold here.
import { withRole } from '@/lib/db';
import { assessStoredGovernance } from '@/lib/governance/stored-provider';
import type { ReaderDb } from '@/lib/governance/runner-bridge';
import type { GateRow } from '@/lib/records';

const PROJECT_REF = 'dgqcanfiapxztmqqlqnh';
const TTL_MS = 30_000;

type Advice = { recommendation: string; reasons: string[] };
const cache = new Map<string, { at: number; advice: Advice }>();

async function advise(runId: string): Promise<Advice> {
  const hit = cache.get(runId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.advice;
  const db = { withRole } as unknown as ReaderDb;
  const result = await assessStoredGovernance(db, runId, { projectRef: PROJECT_REF, sameDatasetSnapshot: false });
  const advice = { recommendation: result.recommendation, reasons: result.reasons };
  cache.set(runId, { at: Date.now(), advice });
  return advice;
}

export async function GovernanceAdvisory({ runId, gate }: { runId: string; gate: GateRow | undefined }) {
  let advice: Advice | null = null;
  try {
    advice = await advise(runId);
  } catch {
    advice = null;
  }
  return (
    <section className="advisory" aria-labelledby="q-advisory">
      <p className="kicker">Read-only advisory. It does not decide anything.</p>
      <h2 id="q-advisory" className="advisory-title">Should we trust the data under this run?</h2>
      {advice ? (
        <>
          <dl className="advisory-pair">
            <div><dt>Completion gate, enforced</dt><dd><span className={`mark mark-${gate?.verdict ?? 'none'}`}>{gate?.verdict ?? 'not recorded'}</span></dd></div>
            <div><dt>Data-trust advisory</dt><dd><span className={`mark mark-${advice.recommendation}`}>{advice.recommendation.replaceAll('_', ' ')}</span></dd></div>
          </dl>
          {advice.reasons.length ? (
            <ul className="advisory-reasons">{advice.reasons.slice(0, 6).map((reason) => <li key={reason}>{reason}</li>)}</ul>
          ) : null}
        </>
      ) : <p className="not-yet">No advisory for this database: the run it assesses is not readable here.</p>}
    </section>
  );
}
