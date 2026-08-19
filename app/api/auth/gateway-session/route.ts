import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { createSession, destroySession } from '@/lib/auth/session';

export const runtime = 'nodejs';

/**
 * Bridges the PHP gateway's auth to the Next.js app's own session
 * cookie. The gateway (gateway/auth/login.php) returns a hand-rolled
 * signed token that only lives in the browser's localStorage — the
 * Next.js server never sees it. Server components like
 * app/dashboard/page.tsx, app/pos/page.tsx, etc. all gate access via
 * getSession(), which reads the httpOnly `pos_session` cookie. This
 * route lets the client exchange a verified gateway token for that
 * cookie right after login (and clear it on logout).
 *
 * Verifies gw_issue_token()'s format from gateway/helpers.php:
 *   base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))
 *
 * REQUIRES: AUTH_SECRET must be the exact same value here and on the
 * cPanel gateway (env var, or gateway/config.local.php's 'auth_secret').
 */
function verifyGatewayToken(token: string): {
  userId: string;
  companyId: string;
  role: string;
  name: string;
  exp: number;
} | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not configured');

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || payload.exp < Date.now() / 1000) return null;
  if (!payload.userId || !payload.companyId || !payload.role || !payload.name) return null;

  return payload;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = body?.token;

  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'Missing token' }, { status: 400 });
  }

  let payload;
  try {
    payload = verifyGatewayToken(token);
  } catch (err) {
    console.error('gateway-session verify error:', err);
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  if (!payload) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 });
  }

  await createSession({
    userId: payload.userId,
    companyId: payload.companyId,
    role: payload.role as any,
    name: payload.name,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  await destroySession();
  return NextResponse.json({ ok: true });
}