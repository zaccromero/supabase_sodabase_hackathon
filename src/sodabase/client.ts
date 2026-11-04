import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Ajv } from 'ajv';
import type { ConnectionStatus, ReadTool, ReadToolClient } from './types.js';

export const SODABASE_ENDPOINT = 'https://sodabase.io/mcp' as const;
const READ_TOOLS = new Set<string>(['data_trust', 'data_trust_health', 'list_inbox', 'explain', 'check_rule']);
const SCAN_TOOL = 'data_trust_scan';
const ajv = new Ajv({ strict: false, allErrors: false });

/**
 * Server-side only. No browser OAuth, persistent rules, monitor changes or SQL execution. These tools never return
 * table rows and data_trust_sample, which hands back a query for them, is deliberately not callable.
 */
export class SodabaseClient implements ReadToolClient {
  readonly provenance = 'live' as const;
  private client: Client | null = null;
  private schemas = new Map<string, object>();
  private credential: string | undefined;
  constructor(token = process.env.SODABASE_MCP_TOKEN) {
    this.credential = token?.trim() || undefined;
  }
  async connect(): Promise<ConnectionStatus> {
    const base = { endpoint: SODABASE_ENDPOINT, observed_at: new Date().toISOString(), credential_present: !!this.credential };
    if (!this.credential) return { ...base, state: 'missing_credentials', tools: [], reason: 'Sodabase access token absent. Owner must connect Supabase in Sodabase and supply SODABASE_MCP_TOKEN.' };
    await this.close();
    const client = new Client({ name: 'company-memory-sodabase-reader', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(SODABASE_ENDPOINT), {
      requestInit: { headers: { Authorization: `Bearer ${this.credential}` }, redirect: 'error' },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(15000)]) }),
    });
    try {
      await client.connect(transport, { timeout: 15000 });
      let cursor: string | undefined;
      // Bounded pagination; an incomplete catalog never authorizes an undiscovered tool.
      for (let page = 0; page < 10; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { timeout: 15000 });
        for (const tool of result.tools) if (READ_TOOLS.has(tool.name) || tool.name === SCAN_TOOL) this.schemas.set(tool.name, tool.inputSchema);
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      this.client = client;
      return { ...base, state: 'ready', tools: [...this.schemas.keys()], reason: 'MCP initialized and tool catalog discovered; no quality result implied.' };
    } catch (error) {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      this.schemas.clear();
      // Never emit error.message: upstream errors can contain headers or credentials.
      const status = typeof error === 'object' && error !== null && 'code' in error ? (error as { code: unknown }).code : null;
      const auth = status === 401 || status === 403 || (error instanceof Error && error.name === 'UnauthorizedError');
      return { ...base, state: auth ? 'authentication_required' : 'unavailable', tools: [], reason: auth ? 'Sodabase rejected authorization; owner authentication/token required.' : 'MCP connection or tool discovery failed; details intentionally sanitized.' };
    }
  }
  private invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    const schema = this.schemas.get(name);
    if (!this.client || !schema) throw new Error('Connection and discovered tool schema required');
    if (!ajv.validate(schema, args)) throw new Error('Arguments do not match discovered Sodabase schema');
    return this.client.callTool({ name, arguments: args }, undefined, { timeout: 20000 });
  }
  async callReadTool(name: ReadTool, args: Record<string, unknown>): Promise<unknown> {
    if (!READ_TOOLS.has(name)) throw new Error('Tool is outside read allowlist');
    if (name === 'check_rule' && (args.persist !== false || 'new_rule' in args)) throw new Error('Only non-persistent rules are allowed');
    return this.invoke(name, args);
  }
  /** Starts a fresh profile of watched tables and returns at once. Separate from reads: it causes work at the provider. */
  async startScan(): Promise<unknown> {
    return this.invoke(SCAN_TOOL, {});
  }
  async close(): Promise<void> {
    const current = this.client;
    this.client = null;
    this.schemas.clear();
    await current?.close().catch(() => {});
  }
}
