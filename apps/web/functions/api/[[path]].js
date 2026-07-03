const DEFAULT_FUNNEL_ORIGIN = 'https://hermes-host.tail04d970.ts.net';
const ALLOWED_API_PATHS = new Set(['search', 'songs', 'meta']);
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function upstreamOrigin(env) {
  const configured = env?.KARAOKE_FUNNEL_ORIGIN;
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim().replace(/\/+$/u, '')
    : DEFAULT_FUNNEL_ORIGIN;
}

function catchAllPath(params) {
  const raw = params?.path;
  if (Array.isArray(raw)) return raw.join('/');
  return typeof raw === 'string' ? raw : '';
}

function preflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, HEAD, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

function notFound() {
  return new Response(JSON.stringify({ error: 'Not found' }), {
    status: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function onRequest(context) {
  const { request, params, env } = context;
  if (!ALLOWED_METHODS.has(request.method)) {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET, HEAD, OPTIONS',
      },
    });
  }
  if (request.method === 'OPTIONS') return preflight();

  const apiPath = catchAllPath(params).replace(/^\/+|\/+$/gu, '');
  if (!ALLOWED_API_PATHS.has(apiPath)) return notFound();

  const incoming = new URL(request.url);
  const upstream = new URL(`/api/${apiPath}`, upstreamOrigin(env));
  upstream.search = incoming.search;

  const response = await fetch(upstream.toString(), {
    method: request.method,
    headers: {
      accept: request.headers.get('accept') ?? 'application/json',
      'user-agent': request.headers.get('user-agent') ?? 'KaraokeDB-Cloudflare-Pages',
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  const headers = new Headers(response.headers);
  headers.set('x-karaokedb-upstream', 'tailscale-funnel');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
