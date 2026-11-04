// The real agents and evaluators, wired for the runner. run.ts and fresh.ts stay free of these imports.
// Generation and the critic go through Hermes OAuth only: no API key, no local CLI, no fallback.
import { createHandlers, driftReviewTask, type AgentDeps } from '../agents/index';
import type { Profile } from '../contract/types';
import { createCriticEvaluator } from '../evaluators/critic';
import { checksFor, createStoredRegistry, guarded } from '../evaluators/index';
import { withHermesCritic, withHermesGeneration } from '../governance-demo/hermes-transport';
import type { Db } from './db';
import { recordReviewFindings } from './fresh';
import { runAgent, type AgentBinding, type RunReport } from './run';

const SLIDE_PACKET = new URL('../../data/curated/milo-slide-text.json', import.meta.url).pathname;

export function liveBinding(db: Db, profile: Profile, deps: Omit<AgentDeps, 'model'> = {}): AgentBinding {
  const critic = withHermesCritic((transport) => guarded(
    createCriticEvaluator({ transport: { ...transport, model: 'hermes_served_model_in_receipt' } as never, criticTimeoutMs: 120_000 }),
    'critic.meaning',
  ));
  return {
    handler: withHermesGeneration((client) => createHandlers({ slidePacketPath: SLIDE_PACKET, ...deps, model: () => client })[profile]),
    evaluators: { ...createStoredRegistry(db), 'critic.meaning': critic },
    checks: (decisions) => checksFor(profile, decisions),
  };
}

/** Runs the drift reviewer over one stored output, and records its findings if the gate completes the review. */
export async function reviewOutput(db: Db, input: { targetOutputId: string; binding?: AgentBinding }): Promise<{ report: RunReport; finding_ids: string[] }> {
  const [target] = await db.withRole('dashboard_reader', (tx) => tx.query<{ body: Record<string, unknown> }>(
    `select body from cm.outputs where id = $1::uuid`, [input.targetOutputId],
  ));
  if (!target) throw new Error(`OUTPUT_NOT_FOUND: ${input.targetOutputId}`);
  const report = await runAgent(db, {
    profile: 'drift_reviewer',
    task: driftReviewTask(input.targetOutputId, target.body),
    binding: input.binding ?? liveBinding(db, 'drift_reviewer'),
  });
  return { report, finding_ids: report.status === 'completed' ? await recordReviewFindings(db, report.run_id) : [] };
}
