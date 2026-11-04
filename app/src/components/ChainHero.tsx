import type { ReactNode } from 'react';
import { acceptDecision } from '@/app/actions';
import { FounderButton } from '@/components/FounderButton';
import { founderWritesAllowed } from '@/lib/db';
import { servedModel, type Chain, type EvaluationRow, type Records } from '@/lib/records';
import { ago, et, profileName, reasonText, short } from '@/lib/format';

function headline(chain: Chain | null): { lead: string; rest: string; yes: boolean } {
  if (!chain) return { lead: 'Not yet.', rest: 'No finding has been recorded, so no correction has been tested.', yes: false };
  if (chain.proven) return { lead: 'Yes.', rest: 'The correction survived a fresh run.', yes: true };
  const { row, freshRun } = chain;
  if (row.verifying_run_id && freshRun?.status !== 'completed') {
    return { lead: 'Not yet.', rest: `The fresh run is ${freshRun?.status ?? 'unreadable'}, so the correction is unproven.`, yes: false };
  }
  if (row.verifying_run_id) return { lead: 'Not proven.', rest: 'A run is named as verifying, but it does not pin the correction in a new run.', yes: false };
  if (chain.correction?.status === 'proposed') return { lead: 'Not yet.', rest: 'A correction is proposed and waits for your acceptance.', yes: false };
  if (row.correction_decision_id) return { lead: 'Not yet.', rest: 'The correction is accepted. No fresh run has followed it.', yes: false };
  return { lead: 'Not yet.', rest: 'Drift is on record. No correction has been recorded.', yes: false };
}

function Step({ n, label, reached, children }: { n: string; label: string; reached: boolean; children: ReactNode }) {
  return (
    <li className={reached ? 'step reached' : 'step'}>
      <div className="step-rail"><span className="step-n">{n}</span></div>
      <h3 className="kicker">{label}</h3>
      {children}
    </li>
  );
}

const NotYet = ({ children }: { children: ReactNode }) => <p className="not-yet">{children}</p>;

function Binding({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="binding">
      {items.map(([k, v]) => (
        <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

const passCount = (e: EvaluationRow[]) => e.filter((x) => x.verdict === 'pass').length;

export function ChainHero({ chain, records, label }: { chain: Chain | null; records: Records; label: ReactNode }) {
  const h = headline(chain);
  const now = records.readAt;
  // No new decision version means nothing was corrected here: the run followed what was already accepted.
  const followedAccepted = !!chain?.proven && !chain.correctionIsNewVersion;
  return (
    <section id="chain" className="hero" aria-labelledby="q-correction">
      <div className="hero-head">
        {followedAccepted ? (
          <>
            {label ? <p className="question">{label}</p> : null}
            <h2 id="q-correction" className="answer yes">Did a fresh run follow the accepted decision? <em>Yes.</em></h2>
          </>
        ) : (
          <>
            <h2 id="q-correction" className="question">Did the correction work? {label}</h2>
            <p className={h.yes ? 'answer yes' : 'answer'}><em>{h.lead}</em> {h.rest}</p>
          </>
        )}
        {chain?.conflictIsReplay ? (
          <p className="flag-line hero-flag">
            <span className="flag">historical replay</span>
            {chain.proven && chain.rejection && chain.correction
              ? `A historical line was replayed and rejected by the gate, then a new run pinned ${chain.correction.decision_key} v${chain.correction.version} and passed.`
              : 'The conflict is a labeled replay of an old slide line, not new model output.'}
          </p>
        ) : null}
      </div>

      {!chain ? (
        <p className="empty">The chain appears here once the drift reviewer writes a finding. No finding exists in <code>cm.findings</code> yet.</p>
      ) : (
        <ol className="chain">
          <Step n="1" label="Decision and source" reached={!!chain.decision}>
            <p className="step-lead">{chain.row.decision_statement}</p>
            <Binding items={[
              ['decision', `${chain.row.decision_key} v${chain.row.decision_version}`],
              ['accepted', chain.decision?.accepted_at ? `${chain.decision.accepted_by}, ${et(chain.decision.accepted_at)}` : `not accepted (${chain.decision?.status ?? 'unknown'})`],
              ['source', chain.row.decision_source],
              ...(chain.row.source_historical ? [['label', 'historical'] as [string, string]] : []),
            ]} />
          </Step>

          <Step n="2" label="Conflicting output" reached={!!chain.conflictAttempt}>
            <blockquote className="excerpt">“{chain.row.excerpt}”</blockquote>
            {chain.conflictIsReplay ? <p className="flag-line"><span className="flag">historical replay</span> Not a model output.</p>
              : chain.conflictIsHistoricalInput ? <p className="flag-line"><span className="flag">historical</span> Input excerpt, not a new incident.</p> : null}
            <p className="step-note">{chain.row.explanation}</p>
            <Binding items={[
              ['run', chain.conflictRun ? `${profileName(chain.conflictRun.profile)} ${short(chain.conflictRun.run_id, 8)}${chain.conflictIsReplay ? ', replay' : chain.conflictRun.memory_mode === 'baseline' ? ', memory off' : ''}` : 'not readable'],
              ['attempt', chain.conflictAttempt ? `${chain.conflictAttempt.attempt_no}, ${chain.conflictAttempt.kind}` : 'not readable'],
              ['model', chain.conflictIsReplay ? 'none, not model-generated' : servedModel(records, chain.conflictRun?.run_id) ?? 'not recorded'],
              ['output', short(chain.conflictAttempt?.output_sha256)],
            ]} />
          </Step>

          <Step n="3" label="Gate rejection" reached={!!chain.rejection}>
            {chain.rejection ? (
              <>
                <p className="stamp">Rejected</p>
                {chain.failedEvaluation ? <p className="step-note">{chain.failedEvaluation.reason}</p> : null}
                <Binding items={[
                  ...chain.rejection.missing.map((m): [string, string] => [m.check_id ?? 'gate', reasonText(m.reason)]),
                  ['at', et(chain.rejection.created_at)],
                ]} />
              </>
            ) : <NotYet>The gate has not rejected this output. No blocked verdict is recorded for its attempt.</NotYet>}
          </Step>

          <Step n="4" label="Repair and correction" reached={!!chain.repairAttempt || !!chain.correction}>
            {chain.repairAttempt || chain.correction ? (
              <>
                {chain.correction && chain.correctionIsNewVersion ? <p className="step-lead">{chain.correction.statement}</p> : <p className="step-lead">{chain.row.proposed_repair}</p>}
                <Binding items={[
                  ...(chain.correction ? [['correction', chain.correctionIsNewVersion
                    ? `${chain.correction.decision_key} v${chain.correction.version}, ${chain.correction.status}`
                    : `${chain.correction.decision_key} v${chain.correction.version}, accepted before this check, no new version`] as [string, string]] : []),
                  ['repair', chain.repairAttempt
                    ? `attempt ${chain.repairAttempt.attempt_no}, gate ${chain.repairGate?.verdict ?? 'not called'}`
                    : chain.conflictIsReplay ? 'none, a replay is not repaired'
                    : chain.conflictRun?.memory_mode === 'baseline' ? 'none, a memory-off baseline gets no repairs' : 'no repair attempt recorded'],
                  ...(chain.repairAttempt ? [['output', short(chain.repairAttempt.output_sha256)] as [string, string]] : []),
                ]} />
                {chain.correction?.status === 'proposed' ? <FounderButton action={acceptDecision} id={chain.correction.id} label="Accept this correction" readOnly={!founderWritesAllowed()} /> : null}
              </>
            ) : <NotYet>Proposed repair: {chain.row.proposed_repair}. Nothing has acted on it yet.</NotYet>}
          </Step>

          <Step n="5" label="Fresh verifying run" reached={chain.proven}>
            {chain.freshRun ? (
              <>
                <p className={chain.proven ? 'stamp proven' : 'stamp'}>{chain.freshRun.status}</p>
                {chain.freshRun.memory_mode === 'baseline' ? <p className="step-note">This run has memory off, so it cannot verify a correction.</p> : null}
                <Binding items={[
                  ['run', `${profileName(chain.freshRun.profile)} ${short(chain.freshRun.run_id, 8)}${chain.freshIsNewRun ? '' : ' (same run)'}`],
                  ['model', servedModel(records, chain.freshRun.run_id) ?? 'not recorded'],
                  ['memory', chain.freshPinsCorrection ? 'pins the correction' : 'correction not pinned'],
                  ['checks', `${passCount(chain.freshEvaluations)} of ${chain.freshEvaluations.length} passed, attempt ${chain.freshRun.attempt_no ?? 'none'}`],
                  ['at', chain.freshRun.completed_at ? et(chain.freshRun.completed_at) : ago(chain.freshRun.created_at, now)],
                ]} />
              </>
            ) : <NotYet>No fresh run has verified this correction. The chain stays open until one does.</NotYet>}
          </Step>
        </ol>
      )}
    </section>
  );
}
