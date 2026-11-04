import type { PullClient } from '../src/sodabase/pull';
import type { ConnectionStatus, ReadTool } from '../src/sodabase/types';

/**
 * TEST DOUBLE. Sodabase does not publish response envelopes and SODABASE_MCP_TOKEN does not exist yet, so these shapes
 * are guesses for exercising the code, not a record of real behavior. Nothing from here may be reported as a result.
 */
export class SodabaseTestDouble implements PullClient {
  readonly provenance = 'test_double' as const;
  calls: Array<{ tool: ReadTool; args: Record<string, unknown> }> = [];
  closed = false;
  constructor(private responses: Partial<Record<ReadTool, unknown | ((args: Record<string, unknown>) => unknown)>>, private state: ConnectionStatus['state'] = 'ready') {}
  async connect(): Promise<ConnectionStatus> {
    return {
      state: this.state, observed_at: 'test double', endpoint: 'https://sodabase.io/mcp', credential_present: this.state !== 'missing_credentials',
      tools: this.state === 'ready' ? (Object.keys(this.responses) as string[]) : [], reason: 'test double',
    };
  }
  async callReadTool(tool: ReadTool, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ tool, args });
    const r = this.responses[tool];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? (r as (a: Record<string, unknown>) => unknown)(args) : r;
  }
  async close(): Promise<void> { this.closed = true; }
}

export const asStructured = (structuredContent: unknown) => ({ structuredContent });
export const asJsonText = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
