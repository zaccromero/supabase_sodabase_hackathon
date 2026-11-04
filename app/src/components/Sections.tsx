import type { ReactNode } from 'react';
import Link from 'next/link';
import { acceptDecision, approveEvaluation } from '@/app/actions';
import { FounderAction } from '@/components/FounderAction';
import { ago, et, profileName, reasonText, short } from '@/lib/format';
import { countedEvaluationIds, historicalLabel, isReplayRun, newest, servedModel, type AttemptRow, type ChainRow, type EvaluationRow, type Records, type RunRow, type SourceFreshness } from '@/lib/records';
import { presentQuality, QUALITY_GROUP_ORDER } from '@/lib/sodabase-presentation';

function Head({ id, question, age, now, tag }: { id: string; question: string; age: Date | null; now: Date; tag: ReactNode }) {
  return (
    <header className="section-head">
      <h2 id={id} className="question">{question}</h2>
      <p className="age">{tag}{age ? `newest record ${ago(age, now)}` : 'no records yet'}</p>
    </header>
  );
}

const Mark = ({ verdict }: { verdict: string }) => (
  <span className={`mark mark-${verdict}`}>{verdict.replaceAll('_', ' ')}</span>
);

const sourceUri = (r: Records, id: string) => r.sources.find((s) => s.id === id);

export function Decisions({ r, tag }: { r: Records; tag: ReactNode }) {
  const order = { proposed: 0, accepted: 1, superseded: 2, rejected: 3 } as Record<string, number>;
  const rows = [...r.decisions].sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9)).slice(0, 12);
  const accepted = r.decisions.filter((d) => d.status === 'accepted').length;
  return (
    <section aria-labelledby="q-decided">
      <Head id="q-decided" question="What did I decide?" age={newest(r.decisions.map((d) => d.accepted_at ?? d.created_at))} now={r.readAt} tag={tag} />
      {rows.length === 0 ? (
        <p className="empty">No decision has been recorded. Nothing in <code>cm.decisions</code> yet, so no run has anything to follow.</p>
      ) : (
        <>
          <p className="section-count">{accepted} accepted, {r.decisions.length - accepted} other versions on record</p>
          <ul className="rows">
            {rows.map((d) => {
              const s = sourceUri(r, d.source_id);
              return (
                <li key={d.id} className={`decision is-${d.status}`}>
                  <p className="decision-statement">{d.statement}</p>
                  <p className="meta">
                    <span>{d.decision_key} v{d.version}</span>
                    <span>{d.status}{d.accepted_by ? ` by ${d.accepted_by}` : ''}</span>
                    <span>build {d.implementation_state.replace('_', ' ')}</span>
                  </p>
                  <p className="meta meta-source">
                    <span>{s ? s.uri : 'source not readable'}</span>
                    {s?.historical ? <span className="flag">historical</span> : null}
                    {s ? <span>captured {ago(s.captured_at, r.readAt)}</span> : null}
                  </p>
                  {d.status === 'proposed' ? <FounderAction action={acceptDecision} id={d.id} label="Accept this decision" /> : null}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

const latestOutput = (r: Records, run: RunRow): AttemptRow | undefined =>
  r.attempts.find((a) => a.id === run.attempt_id);

const text = (v: unknown) => (typeof v === 'string' ? v : null);

// Date-only values stay as written: converting them to ET would move them back a day.
const asOfLabel = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v)) ? v : et(v);

function GymAnswer({ r, run }: { r: Records; run: RunRow }) {
  const body = latestOutput(r, run)?.body;
  if (!body) return <p className="not-yet">{run.status === 'failed' ? 'The latest run ended with no answer.' : 'This run has no output yet.'}</p>;
  const answer = Array.isArray(body.answer) ? (body.answer as Array<Record<string, unknown>>) : [];
  const asOf = text(body.data_as_of);
  const ageDays = typeof body.data_age_days === 'number' ? body.data_age_days : null;
  // A missing count stays unknown. It is never drawn as zero.
  const figures = answer.flatMap((row, i) =>
    Object.entries(row).filter(([k, v]) => k !== 'location_id' && (typeof v === 'number' || v === null)).map(([k, v]) => ({
      key: `${i}-${k}`, value: v === null ? 'unknown' : String(v), label: `${text(row.location_id) ?? 'all'}, ${k.replaceAll('_', ' ')}`,
    })));
  return (
    <div className="agent-body">
      <p className="agent-task">{run.task}</p>
      {run.status !== 'completed' ? (
        <p className="flag-line"><span className="flag">not accepted</span> The gate refused this answer. These are what the agent reported, not a result.</p>
      ) : null}
      <div className="figures">
        {figures.slice(0, 8).map((f) => (
          <div key={f.key} className="figure">
            <span className="figure-n">{f.value}</span>
            <span className="figure-label">{f.label}</span>
          </div>
        ))}
        <div className="figure">
          <span className="figure-n">{ageDays === null ? 'unknown' : `${ageDays}d`}</span>
          <span className="figure-label">data age{asOf ? `, as of ${asOfLabel(asOf)}` : ''}</span>
        </div>
      </div>
      {figures.length > 8 ? <p className="section-count">First 8 of {figures.length} figures shown</p> : null}
      {text(body.definition) ? <p className="step-note">Definition: {text(body.definition)}</p> : null}
    </div>
  );
}

function SlideRevision({ r, run }: { r: Records; run: RunRow }) {
  const body = latestOutput(r, run)?.body;
  if (!body) return <p className="not-yet">This run has no output yet.</p>;
  const before = text(body.before);
  const after = text(body.after);
  const claims = Array.isArray(body.claims) ? (body.claims as Array<Record<string, unknown>>) : [];
  const history = historicalLabel(r, run.output_id);
  return (
    <div className="agent-body">
      <p className="agent-task">{run.task}</p>
      {before ? (
        <>
          {history ? <p className="flag-line"><span className="flag">historical</span> {history}</p> : null}
          <p className="slide-before"><del>{before}</del></p>
        </>
      ) : null}
      {after ?<p className="slide-after">{after}</p> : <p className="not-yet">No revised text in this output.</p>}
      {claims.length ? <p className="step-note">{claims.length} sourced {claims.length === 1 ? 'claim' : 'claims'}</p> : null}
    </div>
  );
}

const lineage = (r: RunRow) => [
  `run ${short(r.run_id, 8)}`,
  `attempt ${r.attempt_no ?? 'none'}`,
  r.memory_mode === 'baseline' ? 'memory off, baseline' : 'memory on',
  r.technique_id ? 'reel technique' : null,
].filter(Boolean).join(', ');

// From the governor's review of how each run was produced. Records do not carry this yet.
const RUN_NOTES: Array<[string, string]> = [['70e040f6', 'Run on an earlier prompt that carried the rule.']];
const runNote = (runId: string) => RUN_NOTES.find(([prefix]) => runId.startsWith(prefix))?.[1] ?? null;

/** Every gate verdict on a run, oldest first, with its reasons, as recorded. */
function GateAttempts({ r, run }: { r: Records; run: RunRow }) {
  const gates = r.gates.filter((g) => g.run_id === run.run_id && g.verdict !== 'completed').reverse();
  if (gates.length === 0) return null;
  const attemptNo = (id: string | null) => r.attempts.find((a) => a.id === id)?.attempt_no ?? '?';
  return (
    <ul className="gate-attempts">
      {gates.map((g) => (
        <li key={g.id}>
          <span className="gate-attempt">Attempt {attemptNo(g.attempt_id)}: gate {g.verdict.replaceAll('_', ' ')}</span>
          {g.missing.map((m, i) => <span key={i} className="gate-reason">{m.check_id ? `${m.check_id}: ` : ''}{reasonText(m.reason)}</span>)}
        </li>
      ))}
    </ul>
  );
}

/** A completed gate can sit beside a failed check that was not required. That disagreement is evidence. */
function Disagreement({ r, run }: { r: Records; run: RunRow }) {
  if (run.status !== 'completed') return null;
  const failed = r.evaluations.filter((e) => e.attempt_id === run.attempt_id && e.verdict === 'fail');
  if (failed.length === 0) return null;
  return (
    <div className="disagreement">
      <p className="flag-line"><span className="flag">not fully clean</span> The gate completed, but a check that was not required failed.</p>
      {failed.map((e) => <p key={e.id} className="eval-reason"><span className="eval-check">{e.check_id}</span> {e.reason}</p>)}
    </div>
  );
}

function GymCard({ r, run }: { r: Records; run: RunRow }) {
  const earlier = r.runs.find((x) => x.profile === 'gym_operator' && x.run_id !== run.run_id && x.status === 'completed' && x.memory_mode === 'on');
  return (
    <>
      <p className="kicker gym-latest">Latest run, {short(run.run_id, 8)}</p>
      <GymAnswer r={r} run={run} />
      <GateAttempts r={r} run={run} />
      <Disagreement r={r} run={run} />
      {earlier ? (
        <div className="gym-earlier">
          <p className="kicker">Earlier completed run, {short(earlier.run_id, 8)}, not the current result</p>
          {runNote(earlier.run_id) ? <p className="flag-line"><span className="flag">earlier prompt</span> {runNote(earlier.run_id)}</p> : null}
          <GymAnswer r={r} run={earlier} />
          <Disagreement r={r} run={earlier} />
        </div>
      ) : null}
    </>
  );
}

function AgentCard({ r, profile, children }: { r: Records; profile: string; children: (run: RunRow) => ReactNode }) {
  const runs = r.runs.filter((x) => x.profile === profile);
  const run = runs.find((x) => x.status !== 'pending' && !x.technique_id && x.memory_mode === 'on') ?? runs[0];
  return (
    <article className="agent">
      <header className="agent-head">
        <h3>{profileName(profile)}</h3>
        {run ? <Mark verdict={run.status} /> : null}
      </header>
      {run ? (
        <>
          {children(run)}
          <p className="meta"><span>{lineage(run)}</span><span>{ago(run.created_at, r.readAt)}</span><span>{runs.length} {runs.length === 1 ? 'run' : 'runs'}</span></p>
          {run.missing.length ? (
            <ul className="missing">{run.missing.map((m, i) => <li key={i}>{m.check_id ? `${m.check_id}: ` : ''}{reasonText(m.reason)}</li>)}</ul>
          ) : null}
        </>
      ) : <p className="not-yet">This agent has not run. No {profile} row in <code>cm.runs</code>.</p>}
    </article>
  );
}

export function Agents({ r, tag }: { r: Records; tag: ReactNode }) {
  const reel = r.runs.find((x) => x.technique_id);
  return (
    <section aria-labelledby="q-agents">
      <Head id="q-agents" question="What is each agent doing?" age={newest(r.runs.map((x) => x.completed_at ?? x.created_at))} now={r.readAt} tag={tag} />
      <div className="agents">
        <AgentCard r={r} profile="gym_operator">{(run) => <GymCard r={r} run={run} />}</AgentCard>
        <AgentCard r={r} profile="milo_pitch">{(run) => <SlideRevision r={r} run={run} />}</AgentCard>
        <AgentCard r={r} profile="drift_reviewer">{(run) => {
          // The runner stores this agent's task as JSON holding the whole target output, so it is not displayed.
          const body = latestOutput(r, run)?.body;
          const found = body?.findings;
          const target = text(body?.target_output_id);
          const reviewed = body?.decisions_reviewed;
          return (
            <div className="agent-body">
              <p className="agent-task">
                {target ? `Reviewed output ${short(target, 8)} against accepted decisions.` : 'Reviews outputs against accepted decisions.'}
              </p>
              <div className="figures">
                {Array.isArray(found) ? (
                  <div className="figure">
                    <span className="figure-n">{found.length}</span>
                    <span className="figure-label">findings in this review</span>
                  </div>
                ) : null}
                {Array.isArray(reviewed) || typeof reviewed === 'number' ? (
                  <div className="figure">
                    <span className="figure-n">{Array.isArray(reviewed) ? reviewed.length : reviewed}</span>
                    <span className="figure-label">decisions reviewed</span>
                  </div>
                ) : null}
              </div>
            </div>
          );
        }}</AgentCard>
        <article className="agent">
          <header className="agent-head">
            <h3>Reel, same process</h3>
            {reel ? <Mark verdict={reel.status} /> : null}
          </header>
          {reel ? (
            <>
              <SlideRevision r={r} run={reel} />
              <p className="meta"><span>{lineage(reel)}</span><span>{ago(reel.created_at, r.readAt)}</span></p>
            </>
          ) : <p className="not-yet">No reel has gone through the process. No run carries a technique yet.</p>}
        </article>
      </div>
      {r.runs.length ? (
        <>
          <h3 className="kicker runs-head">Every run as it happened, newest first ({r.runs.length})</h3>
          <ul className="runs">
            {r.runs.slice(0, 30).map((x) => (
              <li key={x.run_id} className="run">
                <Mark verdict={x.status} />
                <div>
                  <p className="run-title">{profileName(x.profile)} <span className="run-id">{short(x.run_id, 8)}</span></p>
                  <p className="meta">
                    {isReplayRun(r, x.run_id) ? <span className="flag">historical replay</span> : <span>{x.memory_mode === 'baseline' ? 'memory off, baseline' : 'memory on'}</span>}
                    {x.technique_id ? <span>reel technique</span> : null}
                    <span>attempt {x.attempt_no ?? 'none'}</span>
                    <span>{isReplayRun(r, x.run_id) ? 'not model-generated' : servedModel(r, x.run_id) ?? 'model not recorded'}</span>
                    <span>{et(x.created_at)}</span>
                  </p>
                  {runNote(x.run_id) ? <p className="meta"><span className="flag">earlier prompt</span></p> : null}
                  <GateAttempts r={r} run={x} />
                  {x.status === 'completed' && r.evaluations.some((e) => e.attempt_id === x.attempt_id && e.verdict === 'fail') ? <p className="meta"><span className="flag">not fully clean</span></p> : null}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function driftEmpty(r: Records): string {
  const reviews = r.runs.filter((x) => x.profile === 'drift_reviewer' && x.status === 'completed').length;
  if (reviews === 0) return 'The drift reviewer has not completed a review, so nothing has been checked for drift yet.';
  return `The drift reviewer completed ${reviews} ${reviews === 1 ? 'review' : 'reviews'} and no finding is on record. That covers only the outputs it read, not every run.`;
}

export function Drift({ r, selected, tag }: { r: Records; selected: string | null; tag: ReactNode }) {
  return (
    <section aria-labelledby="q-drift">
      <Head id="q-drift" question="Where did it drift?" age={newest(r.chains.map((c) => c.created_at))} now={r.readAt} tag={tag} />
      {r.chains.length === 0 ? (
        <p className="empty">{driftEmpty(r)}</p>
      ) : (
        <ul className="rows">
          {r.chains.map((c: ChainRow) => (
            <li key={c.finding_id} className={selected === c.finding_id ? 'finding is-selected' : 'finding'}>
              <Link href={`/app?finding=${c.finding_id}#chain`} className="finding-link">
                <span className="finding-excerpt">“{c.excerpt}”</span>
                <span className="finding-why">{c.explanation}</span>
                <span className="meta">
                  <span>{c.decision_key} v{c.decision_version}</span>
                  <span>{c.status}</span>
                  <span>{ago(c.created_at, r.readAt)}</span>
                  <span>{selected === c.finding_id ? 'shown above' : 'show chain'}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Evidence({ r, tag }: { r: Records; tag: ReactNode }) {
  const counted = countedEvaluationIds(r);
  const waitsOnFounder = (e: EvaluationRow) =>
    e.verdict === 'uncertain' && counted.has(e.id) && !r.approvals.some((a) => a.evaluation_id === e.id);
  // What needs the founder comes first; otherwise newest first, as read.
  const shown = [...r.evaluations.filter(waitsOnFounder), ...r.evaluations.filter((e) => !waitsOnFounder(e))].slice(0, 8);
  return (
    <section aria-labelledby="q-evidence">
      <Head id="q-evidence" question="What evidence supports it?" age={newest(r.evaluations.map((e) => e.created_at))} now={r.readAt} tag={tag} />
      <p className="section-note">Behavioral evaluations of agent output. Each is bound to one attempt, one output hash and one frozen contract. The gate reads only the latest attempt.</p>
      {shown.length === 0 ? (
        <p className="empty">No evaluator has run. Without an evaluation the gate rejects every completion.</p>
      ) : (
        <>
          <ul className="evals">
            {shown.map((e) => {
              const ev = r.evidence.find((x) => x.id === e.evidence_id);
              const current = counted.has(e.id);
              const approval = r.approvals.find((a) => a.evaluation_id === e.id);
              const run = r.runs.find((x) => x.run_id === e.run_id);
              return (
                <li key={e.id} className={current ? 'eval' : 'eval is-old'}>
                  <div className="eval-verdict"><Mark verdict={e.verdict} /></div>
                  <div className="eval-main">
                    <p className="eval-check">{e.check_id}</p>
                    <p className="eval-reason">{e.reason}</p>
                    {waitsOnFounder(e) ? <FounderAction action={approveEvaluation} id={e.id} label="Approve this evaluation" /> : null}
                    {approval ? <p className="meta"><span>{approval.decision} by {approval.approver}, {ago(approval.created_at, r.readAt)}{run?.status === 'awaiting_approval' ? '. Waiting for the runner to call the gate again.' : '.'}</span></p> : null}
                  </div>
                  <p className="meta eval-binding">
                    <span>{run ? profileName(run.profile) : 'run not readable'}{isReplayRun(r, e.run_id) ? ' (historical replay)' : ''}, {e.evaluator} v{e.evaluator_version}</span>
                    <span>output {short(e.output_sha256)}</span>
                    <span>{ev ? `evidence ${ev.kind}${ev.sha256 ? ` ${short(ev.sha256)}` : ''}` : 'no evidence attached'}</span>
                    <span>{current ? `${ago(e.created_at, r.readAt)}` : 'superseded, gate no longer counts it'}</span>
                  </p>
                </li>
              );
            })}
          </ul>
          {r.evaluations.length > shown.length ? <p className="section-count">Newest {shown.length} of {r.evaluations.length} shown</p> : null}
        </>
      )}
    </section>
  );
}

const PROJECT_REF = 'dgqcanfiapxztmqqlqnh';
const SHOWN: Record<string, number> = { review: 8, coverage: 4, expected: 6, passed: 3, pending: 3 };
const GROUP_TITLE: Record<string, string> = {
  review: 'Needs review', coverage: 'Coverage gaps', expected: 'Expected by definition', passed: 'Reported passes', pending: 'Unresolved or not checked',
};

export function Sodabase({ r, tag, source }: { r: Records; tag: ReactNode; source: SourceFreshness }) {
  const scope = {
    projectRef: process.env.SUPABASE_DB_URL?.includes(PROJECT_REF) ? PROJECT_REF : 'not-this-project',
    mirrorRunId: source.mirrorRunId ?? 'unknown',
  };
  // A check run twice reports the same problem twice; only the newest observation is listed.
  const seen = new Set<string>();
  const latest = r.quality.filter((q) => {
    const key = `${q.provider}/${q.table_name}/${q.verdict}/${q.problem ?? q.provider_finding_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const presented = latest.map((q) => ({ q, view: presentQuality(q, scope) }));
  return (
    <section className="soda" aria-labelledby="q-soda">
      <div className="soda-inner">
        <header className="section-head">
          <div>
            <p className="kicker">Separate check, separate table</p>
            <h2 id="q-soda" className="question">Sodabase: is the underlying data sound?</h2>
          </div>
          <p className="age">{tag}{r.quality.length ? `newest observation ${ago(r.quality[0].observed_at, r.readAt)}` : 'no observations yet'}</p>
        </header>
        <p className="section-note">Sodabase findings describe tables, not agent behavior. They do not feed the completion gate above.</p>
        {source.asOf ? (
          <p className="flag-line soda-flag">
            <span className="flag">{source.ageDays !== null && source.ageDays > 1 ? 'stale source' : 'source date'}</span>
            Latest complete gym source report is {source.asOf}{source.ageDays !== null ? `, ${source.ageDays} days old` : ''}.
          </p>
        ) : null}
        {r.quality.length ? (
          <p className="flag-line soda-flag"><span className="flag">unvalidated</span> As reported by the provider. Our own checks have not validated these yet.</p>
        ) : null}
        {r.quality.length === 0 ? (
          <p className="empty">Sodabase has not reported. No row in <code>cm.quality_findings</code> yet, so the data underneath has not been checked. An empty table is not a passing score.</p>
        ) : (
          <>
            <p className="section-count soda-count">{r.quality.length} observations, {latest.length} distinct.</p>
            {QUALITY_GROUP_ORDER.map((group) => {
              const rows = presented.filter((x) => x.view.group === group);
              if (rows.length === 0) return null;
              const limit = SHOWN[group] ?? 4;
              return (
                <div key={group} className="soda-group">
                  <h3 className="soda-group-title">{GROUP_TITLE[group]} <span className="run-id">{rows.length}</span></h3>
                  <ul className="quality">
                    {rows.slice(0, limit).map(({ q, view }) => (
                      <li key={q.id} className="quality-row">
                        <span className={`mark mark-group-${group}`}>{view.label}</span>
                        <div>
                          <p className="eval-check">{q.table_name}</p>
                          <p className="eval-reason">{q.problem ?? 'The provider gave no detail.'}</p>
                          <p className="soda-explain">{view.explanation}</p>
                        </div>
                        <p className="meta">
                          {q.finding_count !== null ? <span>{q.finding_count} {q.finding_count === 1 ? 'finding' : 'findings'}</span> : null}
                          <span>provider verdict: {view.providerVerdict.replaceAll('_', ' ')}</span>
                          <span>{q.provider}</span>
                          <span>{ago(q.observed_at, r.readAt)}</span>
                        </p>
                      </li>
                    ))}
                  </ul>
                  {rows.length > limit ? <p className="section-count soda-more">{rows.length - limit} more in this group.</p> : null}
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}
