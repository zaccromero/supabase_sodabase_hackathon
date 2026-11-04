// One engine, three profiles. The runner picks a handler by run profile and persists its result.
// Handlers hold no database write path and never touch evaluations, runs or contracts.
import type { Handler, Profile } from '../contract/types.js';
import { createDriftReviewer } from './driftReviewer.js';
import { createGymOperator } from './gymOperator.js';
import { type GymReader, gymReaderFromEnv } from './gymReader.js';
import { createMiloPitch } from './miloPitch.js';
import { anthropicModelClient, type ModelClient } from './model.js';

export interface AgentDeps {
  model?: () => ModelClient;
  gymReader?: () => GymReader;
  investorsDir?: string;
  now?: () => Date;
}

export function createHandlers(deps: AgentDeps = {}): Record<Profile, Handler> {
  const shared = anthropicModelClient();
  const model = deps.model ?? (() => shared);
  return {
    gym_operator: createGymOperator({ model, reader: deps.gymReader ?? gymReaderFromEnv, ...(deps.now ? { now: deps.now } : {}) }),
    milo_pitch: createMiloPitch({ model, ...(deps.investorsDir ? { investorsDir: deps.investorsDir } : {}) }),
    drift_reviewer: createDriftReviewer({ model }),
  };
}

export const handlers: Record<Profile, Handler> = createHandlers();

export { driftReviewTask } from './driftReviewer.js';
export { AgentOutputError, AgentRefusalError, AGENT_MODEL, type ModelClient } from './model.js';
