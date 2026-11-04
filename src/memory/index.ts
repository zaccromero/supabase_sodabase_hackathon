// Company memory: which accepted decisions apply to a profile, and which versions a run pinned.
import type { PinnedDecision, Profile } from '../contract/types';
import type { Db, Tx } from '../runner/db';

/**
 * Only status='accepted' qualifies, so a proposed decision can never reach an agent.
 * decisions.scope holds profile names. drift_reviewer checks work against all of company memory,
 * so it reads every accepted decision whatever its scope.
 */
const IN_SCOPE = `d.status = 'accepted' and ($1::text = 'drift_reviewer' or $1::text = any(d.scope))`;

const DECISION_COLUMNS = `d.id, d.decision_key, d.version, d.statement, s.uri as source_uri, s.historical as source_historical`;

export async function retrieveAccepted(db: Db, profile: Profile): Promise<PinnedDecision[]> {
  return db.withRole('gate_service', (tx) => tx.query<PinnedDecision>(
    `select ${DECISION_COLUMNS}
     from cm.decisions d join cm.sources s on s.id = d.source_id
     where ${IN_SCOPE}
     order by d.decision_key`,
    [profile],
  ));
}

/** Pins what is accepted at this instant, as one statement, so nothing can slip in between read and pin. */
export async function pinAccepted(tx: Tx, runId: string, profile: Profile): Promise<void> {
  await tx.query(
    `insert into cm.run_decisions (run_id, decision_id)
     select $2::uuid, d.id from cm.decisions d where ${IN_SCOPE}`,
    [profile, runId],
  );
}

/** The versions this run pinned. Later supersessions do not change them, so a repair sees the same memory. */
export async function pinnedFor(db: Db, runId: string): Promise<PinnedDecision[]> {
  return db.withRole('gate_service', (tx) => tx.query<PinnedDecision>(
    `select ${DECISION_COLUMNS}
     from cm.run_decisions rd
     join cm.decisions d on d.id = rd.decision_id
     join cm.sources s on s.id = d.source_id
     where rd.run_id = $1::uuid
     order by d.decision_key`,
    [runId],
  ));
}
