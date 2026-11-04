// Model transport through the local `claude -p` login, selected by MODEL_TRANSPORT=cli. It keeps
// the ModelClient contract, so handlers cannot tell the transports apart and every result records
// which one produced it.
//
// Isolation is part of honesty here: a run that inherited the owner's CLAUDE.md, memory or skills
// would not be a no-hint baseline. So the CLI runs in safe mode with no tools, in an empty working
// directory, with a minimal environment. Content travels on stdin and in a temp file, never in argv.
// The CLI still adds its own environment block and the logged-in account's email to the request;
// a context probe on 2026-11-04 found no project, memory or definition text.
// ANTHROPIC_API_KEY stays out of the child's environment because it would override the login.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_MODEL, type ModelClient, type ModelRequest, type ModelResponse } from './model.js';

export const CLI_TRANSPORT = 'claude_cli';
const TIMEOUT_MS = 240_000;
const CHILD_ENV_NAMES = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'SHELL', 'TERM'];

export interface CliRun { code: number | null; stdout: string; stderr: string; }
export type CliRunner = (args: string[], stdin: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<CliRun>;

/** The CLI path failed. Carries its exact message and is never retried through another route. */
export class CliTransportError extends Error {
  constructor(message: string) { super(message); this.name = 'CliTransportError'; }
}

const spawnRunner: CliRunner = (args, stdin, { cwd, env, timeoutMs }) => new Promise((resolve, reject) => {
  const child = spawn(process.env.CLAUDE_CLI_PATH ?? 'claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new CliTransportError(`claude -p timed out after ${timeoutMs} ms`)); }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', (error) => { clearTimeout(timer); reject(new CliTransportError(`claude -p could not start: ${error.message}`)); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(stdin);
});

type AnyBlock = Record<string, unknown> & { type: string };

function renderBlock(block: AnyBlock): string {
  switch (block.type) {
    case 'text': return String(block.text);
    case 'tool_use': return `<tool_call id="${block.id}" name="${block.name}">${JSON.stringify(block.input)}</tool_call>`;
    case 'tool_result': return `<tool_result id="${block.tool_use_id}"${block.is_error ? ' is_error="true"' : ''}>${String(block.content)}</tool_result>`;
    default: return '';
  }
}

/** The whole conversation as text: each call to the CLI is one fresh session. */
export function renderConversation(messages: ModelRequest['messages']): string {
  if (messages.length === 1 && typeof messages[0]!.content === 'string') return messages[0]!.content;
  return messages.map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : (message.content as unknown as AnyBlock[]).map(renderBlock).filter(Boolean).join('\n');
    return `<turn role="${message.role}">\n${content}\n</turn>`;
  }).join('\n') + '\n\nContinue from the last turn.';
}

const toolTurnSchema = (names: string[]) => ({
  type: 'object',
  properties: {
    text: { type: 'string' },
    calls: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string', enum: names }, input: { type: 'object' } },
        required: ['name', 'input'],
      },
    },
  },
  required: ['text', 'calls'],
});

function toolInstructions(tools: NonNullable<ModelRequest['tools']>): string {
  const rows = tools.map((tool) => {
    const { name, description, input_schema } = tool as { name: string; description?: string; input_schema?: unknown };
    return `- ${name}: ${description ?? ''}\n  input schema: ${JSON.stringify(input_schema)}`;
  });
  return `Tools are called through your structured output. To call tools, list them in "calls" with their input and leave "text" empty; their results come back in the next turn. To answer in plain text, leave "calls" empty.\n\nAvailable tools:\n${rows.join('\n')}`;
}

export function cliModelClient(deps: { run?: CliRunner; env?: NodeJS.ProcessEnv } = {}): ModelClient {
  const run = deps.run ?? spawnRunner;
  const parentEnv = deps.env ?? process.env;
  return {
    transport: CLI_TRANSPORT,
    async create(request) {
      const toolNames = (request.tools ?? []).map((tool) => (tool as { name: string }).name);
      const format = request.output_config?.format as { schema?: unknown } | null | undefined;
      const schema = format?.schema ?? (toolNames.length > 0 ? toolTurnSchema(toolNames) : undefined);
      const systemParts = [typeof request.system === 'string' ? request.system : '', toolNames.length > 0 ? toolInstructions(request.tools!) : ''];
      const workDir = mkdtempSync(join(tmpdir(), 'agent-cli-'));
      try {
        const systemFile = join(workDir, 'system-prompt.txt');
        writeFileSync(systemFile, systemParts.filter(Boolean).join('\n\n'));
        const args = [
          '-p',
          '--model', AGENT_MODEL,
          '--output-format', 'json',
          '--tools', '',
          '--safe-mode',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--system-prompt-file', systemFile,
          ...(request.output_config?.effort ? ['--effort', request.output_config.effort] : []),
          ...(schema ? ['--json-schema', JSON.stringify(schema)] : []),
        ];
        const env = Object.fromEntries(CHILD_ENV_NAMES.flatMap((name) => (parentEnv[name] ? [[name, parentEnv[name]]] : [])));
        const { code, stdout, stderr } = await run(args, renderConversation(request.messages), { cwd: workDir, env, timeoutMs: TIMEOUT_MS });
        return parseCliResult(code, stdout, stderr, toolNames.length > 0 && !format);
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
  };
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  stop_reason?: string;
  structured_output?: unknown;
  session_id?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  modelUsage?: Record<string, unknown>;
}

function parseCliResult(code: number | null, stdout: string, stderr: string, toolTurn: boolean): ModelResponse {
  let parsed: CliResult;
  try {
    parsed = JSON.parse(stdout) as CliResult;
  } catch {
    throw new CliTransportError(`claude -p exited ${code}: ${(stderr || stdout).trim().slice(0, 500)}`);
  }
  if (parsed.stop_reason === 'refusal') return message(parsed, [], 'refusal');
  if (parsed.is_error || code !== 0) {
    throw new CliTransportError(`claude -p failed (exit ${code}, ${parsed.subtype ?? 'error'}): ${String(parsed.result ?? stderr).trim().slice(0, 500)}`);
  }
  if (toolTurn) {
    const turn = parsed.structured_output as { text?: string; calls?: Array<{ name: string; input: unknown }> } | undefined;
    if (!turn) throw new CliTransportError('claude -p returned no structured output for a tool turn');
    const calls = (turn.calls ?? []).map((call, index) => ({ type: 'tool_use', id: `cli_call_${index}`, name: call.name, input: call.input ?? {} }));
    if (calls.length > 0) return message(parsed, calls, 'tool_use');
    return message(parsed, [{ type: 'text', text: turn.text ?? '' }], 'end_turn');
  }
  const text = parsed.structured_output !== undefined ? JSON.stringify(parsed.structured_output) : String(parsed.result ?? '');
  return message(parsed, [{ type: 'text', text }], 'end_turn');
}

function message(parsed: CliResult, content: unknown[], stop_reason: string): ModelResponse {
  const served = Object.keys(parsed.modelUsage ?? {})[0] ?? 'unreported';
  return {
    id: `cli_${parsed.session_id ?? 'session'}`,
    type: 'message',
    role: 'assistant',
    model: served,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: (parsed.usage?.input_tokens ?? 0) + (parsed.usage?.cache_creation_input_tokens ?? 0) + (parsed.usage?.cache_read_input_tokens ?? 0),
      output_tokens: parsed.usage?.output_tokens ?? 0,
    },
  } as unknown as ModelResponse;
}
