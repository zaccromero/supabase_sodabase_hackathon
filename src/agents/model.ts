// Model access for all agent profiles. Handlers depend on the ModelClient seam,
// so tests inject a double and production uses the Anthropic SDK.
import Anthropic from '@anthropic-ai/sdk';
import { sha256 } from '../contract/hash.js';
import type { EvidenceInput } from '../contract/types.js';

export const AGENT_MODEL = 'claude-sonnet-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export type ModelRequest = Pick<
  Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
  'system' | 'messages' | 'tools' | 'output_config'
>;
export type ModelResponse = Anthropic.Beta.Messages.BetaMessage;
export type ModelMessage = Anthropic.Beta.Messages.BetaMessageParam;
export interface ModelClient { create(request: ModelRequest): Promise<ModelResponse>; }

/** Reads ANTHROPIC_API_KEY when first called, so importing the registry needs no secret. */
export function anthropicModelClient(): ModelClient {
  let client: Anthropic | undefined;
  return {
    create(request) {
      client ??= new Anthropic();
      return client.beta.messages.create({
        ...request,
        model: AGENT_MODEL,
        max_tokens: 16000,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      });
    },
  };
}

export class AgentRefusalError extends Error {
  constructor(public readonly category: string | null | undefined, explanation?: string | null) {
    super(`Model refused${category ? ` (${category})` : ''}${explanation ? `: ${explanation}` : ''}`);
    this.name = 'AgentRefusalError';
  }
}

/** The model did not produce a usable output inside its turn budget. Nothing is fabricated to fill the gap. */
export class AgentOutputError extends Error {
  constructor(message: string) { super(message); this.name = 'AgentOutputError'; }
}

export function assertUsable(response: ModelResponse): void {
  if (response.stop_reason === 'refusal') {
    throw new AgentRefusalError(response.stop_details?.category, response.stop_details?.explanation);
  }
  if (response.stop_reason === 'max_tokens') throw new AgentOutputError('Model hit max_tokens before finishing');
}

export const responseText = (response: ModelResponse): string =>
  response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('');

/** Records what actually served each attempt, including any server-side fallback. */
export class ModelTrace {
  private readonly servedBy = new Set<string>();
  private inputTokens = 0;
  private outputTokens = 0;
  private calls = 0;

  constructor(private readonly client: ModelClient) {}

  async create(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.create(request);
    this.calls += 1;
    this.servedBy.add(response.model);
    this.inputTokens += response.usage?.input_tokens ?? 0;
    this.outputTokens += response.usage?.output_tokens ?? 0;
    assertUsable(response);
    return response;
  }

  evidence(systemPrompt: string, decisionIds: string[]): EvidenceInput {
    const payload = {
      requested_model: AGENT_MODEL,
      served_by: [...this.servedBy],
      calls: this.calls,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      system_prompt_sha256: sha256(systemPrompt),
      pinned_decision_ids: decisionIds,
    };
    return { kind: 'model_run', sha256: sha256(payload), payload };
  }
}

/**
 * One structured-output call with a bounded correction turn. `validate` returns the
 * problems with a parsed value; an empty list accepts it. Returns the last parsed
 * value and its problems, so the caller decides whether leftovers are fatal.
 */
export async function structuredCall<T>(opts: {
  trace: ModelTrace;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  validate: (value: T) => string[];
  maxCalls?: number;
}): Promise<{ value: T; problems: string[] }> {
  const messages: ModelMessage[] = [{ role: 'user', content: opts.user }];
  const maxCalls = opts.maxCalls ?? 2;
  let last: { value: T; problems: string[] } | undefined;
  for (let call = 0; call < maxCalls; call += 1) {
    const response = await opts.trace.create({
      system: opts.system,
      messages,
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: opts.schema } },
    });
    let value: T;
    try {
      value = JSON.parse(responseText(response)) as T;
    } catch {
      throw new AgentOutputError('Model output was not the requested JSON');
    }
    last = { value, problems: opts.validate(value) };
    if (last.problems.length === 0) return last;
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: `Your output was rejected:\n- ${last.problems.join('\n- ')}\nReturn the corrected JSON in full.`,
    });
  }
  return last!;
}
