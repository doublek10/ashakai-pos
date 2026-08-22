/**
 * Thin fetch wrapper used by every client component in the app:
 * `apiFetch('/api/products', { method: 'POST', body: ... })`.
 *
 * By default this calls the Next.js API routes under /api/* exactly
 * as before (Prisma talking to Postgres, whether that's Supabase or a
 * cPanel-hosted Postgres reached directly — nothing changes there).
 *
 * If NEXT_PUBLIC_BACKEND_MODE=gateway is set, calls are instead
 * translated and sent to a PHP gateway (see /gateway and
 * /gateway/README.md) — e.g. a cashier login becomes a POST to
 * `${NEXT_PUBLIC_GATEWAY_URL}/auth/login.php`, which runs on cPanel
 * and talks to the database itself, then returns JSON. Every call
 * site in the app keeps using apiFetch('/api/...') unchanged; only
 * this file knows which mode is active.
 *
 * NOTE: in gateway mode, login/logout also call
 * /api/auth/gateway-session on the Next.js server itself, so that
 * server components (getSession()-gated pages, middleware) can see
 * the login too — the gateway's own token only lives in this
 * browser's localStorage otherwise.
 */

const BACKEND_MODE = process.env.NEXT_PUBLIC_BACKEND_MODE === 'gateway' ? 'gateway' : 'nextjs';
const GATEWAY_URL = (process.env.NEXT_PUBLIC_GATEWAY_URL ?? '').replace(/\/+$/, '');
const TOKEN_STORAGE_KEY = 'pos_gateway_token';

// ------------------------------------------------------------------
// Gateway token storage. The PHP gateway can't rely on the Next.js
// app's httpOnly session cookie (they're commonly on different
// domains — your POS frontend vs. your cPanel host), so login.php
// returns a signed token instead, which we keep here and attach as
// `Authorization: Bearer <token>` on every subsequent gateway call.
// ------------------------------------------------------------------

export function getGatewayToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

function setGatewayToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// ------------------------------------------------------------------
// Bridges the gateway token to the Next.js server's own session
// cookie (see app/api/auth/gateway-session/route.ts). Best-effort:
// failures here are logged but don't block the gateway call itself
// from resolving, since apps hosted purely client-side (no Next.js
// server, e.g. a static export) won't have this route at all.
// ------------------------------------------------------------------

async function syncServerSession(token: string) {
  try {
    await fetch('/api/auth/gateway-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token }),
    });
  } catch (err) {
    console.error('Failed to sync gateway session with Next.js server:', err);
  }
}

async function clearServerSession() {
  try {
    await fetch('/api/auth/gateway-session', { method: 'DELETE', credentials: 'include' });
  } catch (err) {
    console.error('Failed to clear Next.js server session:', err);
  }
}

// ------------------------------------------------------------------
// Route table: translates a Next.js API call (method + path) into the
// matching PHP script + how to pass its parameters. Path params (like
// the :id in /api/products/:id) and query params are folded into a
// single JSON body that the PHP script reads with gw_field()/$_GET.
// ------------------------------------------------------------------

interface GatewayRoute {
  test: (method: string, path: string) => boolean;
  resolve: (method: string, path: string, search: URLSearchParams) => { file: string; extraQuery?: Record<string, string> };
}

const GATEWAY_ROUTES: GatewayRoute[] = [
  { test: (m, p) => m === 'POST' && p === '/api/auth/login', resolve: () => ({ file: 'auth/login.php' }) },
  { test: (m, p) => m === 'POST' && p === '/api/auth/logout', resolve: () => ({ file: 'auth/logout.php' }) },
  // Re-checks the logged-in user's own password without issuing a new
  // session — used by the POS "remove item from cart" confirmation.
  { test: (m, p) => m === 'POST' && p === '/api/auth/verify-password', resolve: () => ({ file: 'auth/verify_password.php' }) },

  { test: (m, p) => m === 'GET' && p === '/api/products', resolve: (_m, _p, q) => ({ file: 'products/list.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'POST' && p === '/api/products', resolve: () => ({ file: 'products/create.php' }) },
  { test: (m, p) => m === 'PATCH' && /^\/api\/products\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'products/update.php', extraQuery: { productId: p.split('/').pop()! } }) },
  { test: (m, p) => m === 'DELETE' && /^\/api\/products\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'products/delete.php', extraQuery: { productId: p.split('/').pop()! } }) },

  { test: (m, p) => m === 'GET' && p === '/api/inventory', resolve: (_m, _p, q) => ({ file: 'inventory/list.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'POST' && p === '/api/inventory/adjust', resolve: () => ({ file: 'inventory/adjust.php' }) },
  { test: (m, p) => m === 'POST' && p === '/api/inventory/receive', resolve: () => ({ file: 'inventory/receive.php' }) },

  { test: (m, p) => m === 'POST' && p === '/api/sales', resolve: () => ({ file: 'sales/create.php' }) },
  { test: (m, p) => m === 'GET' && p === '/api/sales', resolve: (_m, _p, q) => ({ file: 'sales/list.php', extraQuery: Object.fromEntries(q) }) },

  // Owner-only "Sales" page: sales grouped by day (today first),
  // filterable by payment method, searchable by date. This exact-path
  // rule MUST come before the generic "/api/sales/:id" rule below —
  // that one matches on a regex ([^/]+) and would otherwise swallow
  // "owner-report" as if it were a saleId, since GATEWAY_ROUTES.find()
  // returns the first rule that matches.
  { test: (m, p) => m === 'GET' && p === '/api/sales/owner-report', resolve: (_m, _p, q) => ({ file: 'sales/owner_report.php', extraQuery: Object.fromEntries(q) }) },

  { test: (m, p) => m === 'GET' && /^\/api\/sales\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'sales/get.php', extraQuery: { saleId: p.split('/').pop()! } }) },

  { test: (m, p) => m === 'GET' && p === '/api/users', resolve: () => ({ file: 'users/list.php' }) },
  { test: (m, p) => m === 'POST' && p === '/api/users', resolve: () => ({ file: 'users/create.php' }) },
  { test: (m, p) => m === 'PATCH' && /^\/api\/users\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'users/update.php', extraQuery: { userId: p.split('/').pop()! } }) },
  
  { test: (m, p) => m === 'GET' && p === '/api/branches', resolve: () => ({ file: 'branches/list.php' }) },

  { test: (m, p) => m === 'GET' && p === '/api/reports', resolve: (_m, _p, q) => ({ file: 'reports/summary.php', extraQuery: Object.fromEntries(q) }) },

  // M-Pesa STK push runs entirely in PHP (gateway/payments/mpesa_stk.php)
  // so it never needs DATABASE_URL/Prisma from the Next.js side — see
  // gateway/README.md. The webhook (gateway/webhooks/mpesa_callback.php)
  // is a separate public URL Daraja calls directly; it's never reached
  // through apiFetch at all.
  { test: (m, p) => m === 'POST' && p === '/api/payments/mpesa', resolve: () => ({ file: 'payments/mpesa_stk.php' }) },

  // "Customer already paid" (no STK) + manual C2B reconciliation flow —
  // see gateway/webhooks/mpesa_c2b_confirmation.php for the listener
  // side. These three are new UI-facing endpoints for that flow.
  { test: (m, p) => m === 'POST' && p === '/api/payments/mpesa/manual', resolve: () => ({ file: 'payments/mpesa_manual_pending.php' }) },
  { test: (m, p) => m === 'GET' && p === '/api/payments/mpesa/c2b-lookup', resolve: (_m, _p, q) => ({ file: 'payments/mpesa_c2b_lookup.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'POST' && p === '/api/payments/mpesa/c2b-match', resolve: () => ({ file: 'payments/mpesa_c2b_match.php' }) },

  // "Activate M-Pesa capture" button on the till (OWNER only) — wraps
  // gateway/scripts/register_c2b_urls.php so nobody has to hand-type
  // that PHP URL. Safe to click repeatedly; it just re-registers.
  { test: (m, p) => m === 'GET' && p === '/api/settings/mpesa/register-c2b', resolve: () => ({ file: 'scripts/register_c2b_urls.php' }) },
];

function resolveGatewayRoute(method: string, path: string, search: URLSearchParams) {
  const route = GATEWAY_ROUTES.find((r) => r.test(method, path));
  if (!route) return null;
  return route.resolve(method, path, search);
}

async function gatewayFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const [path, queryString] = url.split('?');
  const search = new URLSearchParams(queryString ?? '');
  const method = (init?.method ?? 'GET').toUpperCase();

  const resolved = resolveGatewayRoute(method, path, search);
  if (!resolved) {
    throw new Error(
      `No PHP gateway route configured for ${method} ${path}. ` +
        `Add one to GATEWAY_ROUTES in lib/api-client.ts, or add the matching .php file under /gateway.`
    );
  }

  const bodyFromCaller = init?.body ? JSON.parse(init.body as string) : {};
  const mergedParams = { ...resolved.extraQuery, ...bodyFromCaller };

  const isGetLike = method === 'GET';
  const target = `${GATEWAY_URL}/${resolved.file}${isGetLike ? `?${new URLSearchParams(mergedParams as Record<string, string>)}` : ''}`;

  const token = getGatewayToken();
  const res = await fetch(target, {
    method: isGetLike ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: isGetLike ? undefined : JSON.stringify(mergedParams),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error ?? `Gateway request failed: ${res.status}`);
  }

  // Login responses carry the token the gateway wants us to use on
  // every future request — stash it automatically so callers don't
  // have to think about it. Also exchange it for a real Next.js
  // session cookie, so server components and middleware can see the
  // login too — the gateway token alone only lives in localStorage,
  // which the Next.js server never sees on its own.
  if ((data as any)?.token) {
    setGatewayToken((data as any).token);
    await syncServerSession((data as any).token);
  }
  if (path === '/api/auth/logout') {
    setGatewayToken(null);
    await clearServerSession();
  }

  return data as T;
}

// ------------------------------------------------------------------
// M-Pesa now has a full PHP implementation (see GATEWAY_ROUTES above)
// and is allowed to route through the gateway like everything else.
// PesaPal and card payments are NOT ported to PHP — they still need a
// long-lived Next.js server to receive their callbacks — so those
// always hit the Next.js server directly, even in gateway mode, and
// require DATABASE_URL to be set there.
// ------------------------------------------------------------------
const ALWAYS_DIRECT = [/^\/api\/payments\/pesapal/, /^\/api\/payments\/cards/, /^\/api\/webhooks\//];

/** Thin fetch wrapper: JSON in/out, throws with the server's error message on failure. */
export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const path = url.split('?')[0];
  const forceDirect = ALWAYS_DIRECT.some((re) => re.test(path));

  if (BACKEND_MODE === 'gateway' && !forceDirect) {
    return gatewayFetch<T>(url, init);
  }

  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as any)?.error ?? `Request failed: ${res.status}`);
  }
  return data as T;
}
