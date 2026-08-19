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

  { test: (m, p) => m === 'GET' && p === '/api/products', resolve: (_m, _p, q) => ({ file: 'products/list.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'POST' && p === '/api/products', resolve: () => ({ file: 'products/create.php' }) },
  { test: (m, p) => m === 'PATCH' && /^\/api\/products\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'products/update.php', extraQuery: { productId: p.split('/').pop()! } }) },
  { test: (m, p) => m === 'DELETE' && /^\/api\/products\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'products/delete.php', extraQuery: { productId: p.split('/').pop()! } }) },

  { test: (m, p) => m === 'GET' && p === '/api/inventory', resolve: (_m, _p, q) => ({ file: 'inventory/list.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'POST' && p === '/api/inventory/adjust', resolve: () => ({ file: 'inventory/adjust.php' }) },
  { test: (m, p) => m === 'POST' && p === '/api/inventory/receive', resolve: () => ({ file: 'inventory/receive.php' }) },

  { test: (m, p) => m === 'POST' && p === '/api/sales', resolve: () => ({ file: 'sales/create.php' }) },
  { test: (m, p) => m === 'GET' && p === '/api/sales', resolve: (_m, _p, q) => ({ file: 'sales/list.php', extraQuery: Object.fromEntries(q) }) },
  { test: (m, p) => m === 'GET' && /^\/api\/sales\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'sales/get.php', extraQuery: { saleId: p.split('/').pop()! } }) },

  { test: (m, p) => m === 'GET' && p === '/api/users', resolve: () => ({ file: 'users/list.php' }) },
  { test: (m, p) => m === 'POST' && p === '/api/users', resolve: () => ({ file: 'users/create.php' }) },
  { test: (m, p) => m === 'PATCH' && /^\/api\/users\/[^/]+$/.test(p), resolve: (_m, p) => ({ file: 'users/update.php', extraQuery: { userId: p.split('/').pop()! } }) },

  { test: (m, p) => m === 'GET' && p === '/api/reports', resolve: (_m, _p, q) => ({ file: 'reports/summary.php', extraQuery: Object.fromEntries(q) }) },
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
  // have to think about it.
  if ((data as any)?.token) setGatewayToken((data as any).token);
  if (path === '/api/auth/logout') setGatewayToken(null);

  return data as T;
}

/** Thin fetch wrapper: JSON in/out, throws with the server's error message on failure. */
export async function apiFetch<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  if (BACKEND_MODE === 'gateway') {
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
