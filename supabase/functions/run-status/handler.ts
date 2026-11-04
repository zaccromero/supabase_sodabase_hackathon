// Read-only gate status for one run, from cm.v_run_status. No Deno or driver imports, so tests run
// this exact file. The query names its columns, and the response is rebuilt from an allowlist:
// cm.runs.task is never read, because a task can quote a whole output under review.
export const STATUS_SQL = `select run_id, profile, status, memory_mode, attempt_no, output_sha256, contract_sha256, missing, created_at, completed_at
from cm.v_run_status where run_id = $1::uuid`;

/** Statements the connection layer runs around STATUS_SQL, in one transaction that is always read-only. */
export const READ_ROLE = 'dashboard_reader';
export const STATEMENT_TIMEOUT = '2s';

export const BOARD_ORIGIN = 'https://company-memory-kohl.vercel.app';
export const RATE_LIMIT = { limit: 60, windowMs: 60_000, maxClients: 10_000 };
const MAX_MISSING = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface StatusRow {
  run_id: string; profile: string; status: string; memory_mode: string; attempt_no: number | null;
  output_sha256: string | null; contract_sha256: string | null; missing: unknown;
  created_at: string | Date; completed_at: string | Date | null;
}
export type ReadStatus = (runId: string) => Promise<StatusRow | undefined>;

/**
 * Fixed window per client. Each isolate counts on its own, so this limits a burst to one instance
 * rather than giving a global quota. The client map is bounded, so it cannot grow without limit.
 */
export function createRateLimiter({ limit, windowMs, maxClients } = RATE_LIMIT, now: () => number = Date.now) {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (client: string): { allowed: boolean; retryAfterSeconds: number } => {
    const at = now();
    let current = windows.get(client);
    if (!current || at - current.startedAt >= windowMs) {
      if (!current && windows.size >= maxClients) windows.clear();
      current = { startedAt: at, count: 0 };
      windows.set(client, current);
    }
    current.count += 1;
    return { allowed: current.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((current.startedAt + windowMs - at) / 1000)) };
  };
}

const iso = (value: string | Date | null) => (value instanceof Date ? value.toISOString() : value);
const text = (value: unknown) => (typeof value === 'string' ? value : undefined);

function missingChecks(value: unknown) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, MAX_MISSING).map((row) => {
    const item = (row ?? {}) as Record<string, unknown>;
    return { check_id: text(item.check_id) ?? null, reason: text(item.reason) ?? null, evaluation_id: text(item.evaluation_id) ?? null };
  });
}

export function createHandler(readStatus: ReadStatus, limiter = createRateLimiter()) {
  const respond = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': status === 200 ? 'private, max-age=5' : 'no-store',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': BOARD_ORIGIN,
      vary: 'Origin',
      ...extra,
    },
  });

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return respond(204, null, { 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'authorization, apikey' });
    }
    if (request.method !== 'GET') return respond(405, { error: 'METHOD_NOT_ALLOWED' }, { allow: 'GET, OPTIONS' });

    const client = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    const { allowed, retryAfterSeconds } = limiter(client);
    if (!allowed) return respond(429, { error: 'RATE_LIMITED' }, { 'retry-after': String(retryAfterSeconds) });

    const runId = new URL(request.url).searchParams.get('run_id');
    if (!runId || !UUID.test(runId)) return respond(400, { error: 'INVALID_RUN_ID' });

    let row: StatusRow | undefined;
    try {
      row = await readStatus(runId.toLowerCase());
    } catch {
      // Driver errors can name hosts, roles or SQL, so only a fixed code leaves.
      return respond(503, { error: 'UNAVAILABLE' }, { 'retry-after': '5' });
    }
    if (!row) return respond(404, { error: 'RUN_NOT_FOUND' });

    const missing = missingChecks(row.missing);
    return respond(200, {
      run_id: row.run_id,
      profile: row.profile,
      status: row.status,
      memory_mode: row.memory_mode,
      attempt_no: row.attempt_no,
      output_sha256: row.output_sha256,
      contract_sha256: row.contract_sha256,
      gate_clear: missing.length === 0,
      missing,
      created_at: iso(row.created_at),
      completed_at: iso(row.completed_at),
    });
  };
}
