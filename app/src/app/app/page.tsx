import Link from 'next/link';
import { MemberExpirationReview } from '@/components/MemberExpirationReview';
import { ChainHero } from '@/components/ChainHero';
import { GovernanceAdvisory } from '@/components/GovernanceAdvisory';
import { VERIFIED_MILO_RUN, VerifiedRun } from '@/components/VerifiedRun';
import { LiveRefresh } from '@/components/LiveRefresh';
import { Safeguards } from '@/components/Safeguards';
import { Agents, Decisions, Drift, Evidence, Sodabase } from '@/components/Sections';
import { dbMode, liveDatabaseLabel, type DbMode } from '@/lib/db';
import { et, ago } from '@/lib/format';
import { buildChain, newest, readRecords, readSourceFreshness, type Records, type SourceFreshness } from '@/lib/records';

export const dynamic = 'force-dynamic';

const THE_LINE = 'Supabase holds the decisions and execution record. Sodabase checks the underlying data quality. Our evaluators check whether the agent actually followed the decisions.';

function ReadFailure({ error }: { error: unknown }) {
  const code = (error as { code?: string }).code;
  const missing = code === '3F000' || code === '42P01';
  const role = code === '42501' || code === '22023';
  const tls = code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
  if (code === 'NO_DATABASE') {
    return (
      <section className="failure" role="status">
        <h2 className="answer">No database connected yet.</h2>
        <p className="section-note">This hosted page reads only the live Supabase record, and it has no connection to one yet. Nothing is shown, because nothing was read.</p>
      </section>
    );
  }
  return (
    <section className="failure" role="alert">
      <h2 className="answer">Records could not be read.</h2>
      <p className="section-note">
        {missing
          ? 'The database answered, but the cm schema is not there. The core migration has not been applied to it.'
          : role
            ? 'The database refused the dashboard_reader role for this connection.'
            : tls
              ? 'The database certificate could not be verified. Set SUPABASE_DB_CA to its CA.'
              : 'The live database did not answer. No records are shown, because none were read.'}
        {code ? ` Database code ${code}.` : ''}
      </p>
    </section>
  );
}

function Masthead({ mode, records, source }: { mode: DbMode; records: Records | null; source: SourceFreshness | null }) {
  const newestRecord = records
    ? newest([
        ...records.runs.map((x) => x.completed_at ?? x.created_at),
        ...records.evaluations.map((x) => x.created_at),
        ...records.gates.map((x) => x.created_at),
        ...records.decisions.map((x) => x.accepted_at ?? x.created_at),
        ...records.quality.map((x) => x.observed_at),
      ])
    : null;
  return (
    <>
      {mode === 'local' ? (
        <div className="test-band" role="status">
          <strong>Local test database.</strong> <span>Test rows written through the real SQL into PGlite. Not company records.</span>
        </div>
      ) : null}
      <header className="masthead">
        <div>
          <h1 className="wordmark"><Link href="/"><span className="brand-glyph" aria-hidden="true">cm</span>Company Memory</Link></h1>
          <p className="pitch">I can build faster than ever. Why am I still repeating myself to my agents?</p>
        </div>
        <dl className="freshness">
          <div><dt>Records</dt><dd>{mode === 'local' ? 'Local test database' : mode === 'live' ? liveDatabaseLabel() : 'Not connected'}</dd></div>
          <div><dt>Read</dt><dd>{records ? et(records.readAt) : mode === 'none' ? 'not attempted' : 'failed'}</dd></div>
          <div><dt>Newest record</dt><dd>{records && newestRecord ? ago(newestRecord, records.readAt) : 'none yet'}</dd></div>
          {source?.asOf ? (
            <div><dt>Gym source data</dt><dd>{source.asOf}{source.ageDays !== null && source.ageDays > 1 ? `, stale, ${source.ageDays}d old` : ''}</dd></div>
          ) : null}
        </dl>
      </header>
    </>
  );
}

export default async function Page({ searchParams }: { searchParams: Promise<{ finding?: string }> }) {
  const mode = dbMode();
  const { finding } = await searchParams;
  let records: Records | null = null;
  let failure: unknown = null;
  try {
    records = await readRecords();
  } catch (error) {
    failure = error;
  }
  const tag = mode === 'local' ? <span className="test-tag">local test database</span> : null;

  if (!records) {
    return (
      <main>
        <Masthead mode={mode} records={null} source={null} />
        <ReadFailure error={failure} />
        <LiveRefresh />
      </main>
    );
  }

  const r = records;
  const source = await readSourceFreshness();
  const verifiedGate = r.gates.find((g) => g.run_id === VERIFIED_MILO_RUN);
  const picked = r.chains.find((c) => c.finding_id === finding)
    ?? r.chains.find((c) => c.status === 'verified')
    ?? r.chains[0]
    ?? null;
  const chain = picked ? buildChain(r, picked) : null;

  return (
    <main>
      <Masthead mode={mode} records={r} source={source} />
      <ChainHero chain={chain} records={r} label={tag} />
      <div className="proof-row">
        <div className="verified-run"><VerifiedRun r={r} /></div>
        <GovernanceAdvisory runId={VERIFIED_MILO_RUN} gate={verifiedGate} />
      </div>
      <Safeguards />
      <div className="columns">
        <Decisions r={r} tag={tag} />
        <Agents r={r} tag={tag} />
      </div>
      <div className="columns columns-even">
        <Drift r={r} selected={picked?.finding_id ?? null} tag={tag} />
        <Evidence r={r} tag={tag} />
      </div>
      <Sodabase r={r} tag={tag} source={source} />
      <MemberExpirationReview />
      <footer className="colophon"><p>{THE_LINE}</p></footer>
      <LiveRefresh />
    </main>
  );
}
