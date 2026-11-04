// One engine, three profiles. The runner picks a handler by run profile and persists its result.
// Handlers hold no database write path and never touch evaluations, runs or contracts.
import type { Handler, Profile } from '../contract/types.js';
import { cliModelClient } from './cliModel.js';
import { createDriftReviewer } from './driftReviewer.js';
import { createGymOperator } from './gymOperator.js';
import { type GymReader, gymReaderFromEnv } from './gymReader.js';
import { createMiloPitch } from './miloPitch.js';
import { anthropicModelClient, type ModelClient } from './model.js';

export interface AgentDeps {
  model?: () => ModelClient;
  gymReader?: () => GymReader;
  investorsDir?: string;
  slidePacketPath?: string;
  now?: () => Date;
}

/** The API by default; MODEL_TRANSPORT=cli selects the local login. There is no automatic fallback between them. */
export function modelClientFromEnv(transport = process.env.MODEL_TRANSPORT): ModelClient {
  if (transport === 'cli') return cliModelClient();
  if (transport === undefined || transport === '' || transport === 'api') return anthropicModelClient();
  throw new Error(`Unknown MODEL_TRANSPORT "${transport}"`);
}

export function createHandlers(deps: AgentDeps = {}): Record<Profile, Handler> {
  let selected: ModelClient | undefined;
  const model = deps.model ?? (() => (selected ??= modelClientFromEnv()));
  return {
    gym_operator: createGymOperator({ model, reader: deps.gymReader ?? gymReaderFromEnv, ...(deps.now ? { now: deps.now } : {}) }),
    milo_pitch: createMiloPitch({
      model,
      ...(deps.investorsDir ? { investorsDir: deps.investorsDir } : {}),
      ...(deps.slidePacketPath ? { slidePacketPath: deps.slidePacketPath } : {}),
    }),
    drift_reviewer: createDriftReviewer({ model }),
  };
}

export const handlers: Record<Profile, Handler> = createHandlers();

export { driftReviewTask } from './driftReviewer.js';
export { AgentOutputError, AgentRefusalError, AGENT_MODEL, type ModelClient } from './model.js';
