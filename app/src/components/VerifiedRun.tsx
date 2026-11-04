import { historicalLabel, type Records } from '@/lib/records';
export const VERIFIED_MILO_RUN='eed0520a-f35d-4a5b-8b04-123695082aa8';
const CHECKS=['milo.no_forbidden_claim','milo.claims_sourced','critic.meaning'];
/** Exact persisted proof, independent from cm.findings/repair lifecycle. Never starts a run. */
export function VerifiedRun({r,runId=VERIFIED_MILO_RUN}:{r:Records;runId?:string}){
  const run=r.runs.find(x=>x.run_id===runId&&x.profile==='milo_pitch');
  if(!run)return <section><h2 className="question">Fresh-memory run evidence</h2><p className="empty">The requested Milo run is not readable in this snapshot. No verification is inferred.</p></section>;
  const attempt=r.attempts.find(x=>x.id===run.attempt_id&&x.output_id===run.output_id);
  const pin=r.decisions.find(d=>d.id==='0cb43524-2f09-5427-89cb-67614535bee0'&&d.decision_key==='milo.gym_nyc_partner'&&d.version===1&&d.status==='accepted'&&d.accepted_by&&d.accepted_at&&new Date(d.accepted_at)<=new Date(run.created_at)&&r.pins.some(p=>p.run_id===runId&&p.decision_id===d.id));
  const gate=r.gates.filter(g=>g.run_id===runId&&g.attempt_id===run.attempt_id).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()||b.id.localeCompare(a.id))[0];
  const checks=CHECKS.map(check=>{
    const e=r.evaluations.filter(e=>e.run_id===runId&&e.check_id===check&&e.attempt_id===run.attempt_id&&e.output_id===run.output_id&&e.output_sha256===run.output_sha256&&e.contract_sha256===run.contract_sha256).sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime()||b.id.localeCompare(a.id))[0];
    const evidence=e?.evidence_id?r.evidence.find(v=>v.id===e.evidence_id&&v.output_id===run.output_id&&v.created_by===e.evaluator&&v.created_by!=='agent_worker'):undefined;
    return {check,e,evidence,passes:!!e&&e.verdict==='pass'&&!!evidence};
  });
  const verified=!!pin&&run.status==='completed'&&run.memory_mode==='on'&&run.attempt_no===1&&!run.parent_run_id&&!!attempt?.body&&run.missing.length===0&&gate?.verdict==='completed'&&gate.missing.length===0&&checks.every(c=>c.passes);
  const body=attempt?.body;
  const before=typeof body?.before==='string'?body.before:null,after=typeof body?.after==='string'?body.after:null;
  return <section aria-labelledby="q-exact-run" id={`run-${runId}`}>
    <header className="section-head"><h2 className="question" id="q-exact-run">Fresh accepted-memory run</h2><span className={`mark mark-${verified?'pass':'uncertain'}`}>{verified?'Verified current records':'Proof incomplete'}</span></header>
    <p className="decision-statement">{verified?'Completed with the approved partnership decision retrieved and pinned.':'Some required evidence is absent or does not match this run.'}</p>
    <p className="meta" style={{overflowWrap:'anywhere'}}>Run <a href={`#run-${runId}`}>{runId}</a> · memory {run.memory_mode} · attempt {run.attempt_no??'unknown'}</p>
    <p className="meta">Approved pin: {pin?'milo.gym_nyc_partner@1':'not verified'} {pin?.accepted_by?`· accepted by ${pin.accepted_by}`:''}</p>
    <div className="columns columns-even"><div><h3>Historical input</h3><p className="meta">{historicalLabel(r,run.output_id)||'Historical before text; not a new incident.'}</p><blockquote>{before||'Not supplied.'}</blockquote></div><div><h3>Actual corrected output</h3><p>{after||'Not supplied.'}</p></div></div>
    <ul className="rows">{checks.map(c=><li key={c.check}><span className={`mark mark-${c.passes?'pass':'uncertain'}`}>{c.passes?'Pass':c.e?.verdict||'not verified'}</span> <strong>{c.check}</strong><p>{c.e?.reason||'No current bound evaluation supplied.'}</p><p className="meta">Independent current-output evidence {c.evidence?.id||'not verified'}</p></li>)}</ul>
    <p>Stored database gate: <strong>{gate?.verdict||'not supplied'}</strong> · {gate?.missing.length===0?'no missing requirements':`${gate?.missing.length??'unknown'} missing requirements`}</p>
    <details><summary>Exact output and contract binding</summary><p className="meta" style={{overflowWrap:'anywhere'}}>Output {run.output_id}<br/>SHA-256 {run.output_sha256}<br/>Contract {run.contract_id}<br/>SHA-256 {run.contract_sha256}</p></details>
    <p className="section-note">This run proof is separate from the finding → repair → verification chain. A missing finding remains missing; no finding or repair is invented here. Data-trust advice remains separate from this completed execution gate.</p>
  </section>;
}
