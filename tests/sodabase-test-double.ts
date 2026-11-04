import { SODABASE_PROJECT_REF } from '../src/sodabase/client';
import type { PullClient } from '../src/sodabase/pull';
import type { ConnectionStatus, ReadTool } from '../src/sodabase/types';

/**
 * TEST DOUBLE. The {result: string} envelope comes from the live tool catalog, but SODABASE_MCP_TOKEN does not exist yet,
 * so the fields inside it are assumptions for exercising the code. Nothing from here may be reported as a result.
 */
export class SodabaseTestDouble implements PullClient {
  readonly provenance = 'test_double' as const;
  calls: Array<{ tool: ReadTool; args: Record<string, unknown> }> = [];
  closed = false;
  constructor(private responses: Partial<Record<ReadTool, unknown | ((args: Record<string, unknown>) => unknown)>>, private state: ConnectionStatus['state'] = 'ready', private listedProject: string = SODABASE_PROJECT_REF) {}
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
  async verifyProject(ref: string = SODABASE_PROJECT_REF): Promise<boolean> { return this.listedProject === ref; }
  async close(): Promise<void> { this.closed = true; }
}

export const asStructured = (structuredContent: unknown) => ({ structuredContent });
export const asJsonText = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
/** The live envelope: outputSchema {result: string}, with the data as a JSON string inside it. */
export const asLiveEnvelope = (value: unknown) => ({ structuredContent: { result: JSON.stringify(value) }, content: [{ type: 'text', text: JSON.stringify({ result: JSON.stringify(value) }) }] });
