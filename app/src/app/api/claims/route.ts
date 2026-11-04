// Agents coordinate here. Hosted, every call needs the COORD_TOKEN bearer token and the
// route refuses everyone if it is not configured. On this Mac no token is needed, and
// requiring a JSON body stops another website's page from posting to localhost.
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { claim, postMessage, readBoard, release } from '@/lib/claims';

export const dynamic = 'force-dynamic';

const digest = (v: string) => createHash('sha256').update(v).digest();

function refused(request: NextRequest): NextResponse | null {
  if (!process.env.VERCEL) return null;
  const token = process.env.COORD_TOKEN;
  if (!token) return NextResponse.json({ error: 'COORD_TOKEN is not configured' }, { status: 503 });
  const given = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  return timingSafeEqual(digest(given), digest(token)) ? null : NextResponse.json({ error: 'token required' }, { status: 401 });
}

function failure(error: unknown): NextResponse {
  const code = (error as { code?: string }).code;
  if (code === '3F000' || code === '42P01') return NextResponse.json({ error: 'coord tables are not on this database yet' }, { status: 503 });
  if (code === '23514') return NextResponse.json({ error: 'a field is too long' }, { status: 400 });
  return NextResponse.json({ error: 'the request did not go through', code }, { status: 500 });
}

export async function GET(request: NextRequest) {
  const denied = refused(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await readBoard());
  } catch (error) {
    return failure(error);
  }
}

const field = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function POST(request: NextRequest) {
  const denied = refused(request);
  if (denied) return denied;
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return NextResponse.json({ error: 'send application/json' }, { status: 415 });
  }
  const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!input) return NextResponse.json({ error: 'send a JSON object' }, { status: 400 });
  const action = field(input.action);
  const agent = field(input.agent);
  const page = field(input.page);
  if (!agent) return NextResponse.json({ error: 'agent is required' }, { status: 400 });
  try {
    if (action === 'claim' && page) return NextResponse.json(await claim(page, agent, field(input.intent)));
    if (action === 'release' && page) {
      return NextResponse.json(await release(page, field(input.for_agent) || agent, agent));
    }
    if (action === 'message' && field(input.body)) {
      await postMessage(agent, page || null, field(input.body));
      return NextResponse.json({ posted: true });
    }
  } catch (error) {
    return failure(error);
  }
  return NextResponse.json({ error: 'action must be claim or release (with page), or message (with body)' }, { status: 400 });
}
