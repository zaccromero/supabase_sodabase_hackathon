// Password gate for the hosted page. Local runs stay open unless DASHBOARD_PASSWORD is set.
// Hosted with no password configured, the page refuses everyone rather than opening up.
import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

const digest = (v: string) => createHash('sha256').update(v).digest();

function passwordMatches(header: string | null, password: string): boolean {
  if (!header?.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const given = decoded.slice(decoded.indexOf(':') + 1);
  return timingSafeEqual(digest(given), digest(password));
}

export function proxy(request: NextRequest) {
  // The claims API checks its own bearer token, so agents do not need the page password.
  if (request.nextUrl.pathname === '/api/claims') return NextResponse.next();
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    // *.vercel.app sits behind Vercel Authentication. A custom domain does not, so it stays shut.
    if (process.env.VERCEL && !request.nextUrl.hostname.endsWith('.vercel.app')) {
      return new NextResponse('Dashboard password is not configured.', { status: 503 });
    }
    return NextResponse.next();
  }
  if (passwordMatches(request.headers.get('authorization'), password)) return NextResponse.next();
  return new NextResponse('Password required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Company Memory", charset="UTF-8"' },
  });
}

export const config = { matcher: '/:path*' };
