const DEFAULT_FUNNEL_ORIGIN = 'https://oci.tail04d970.ts.net';

function upstreamOrigin(env) {
  const configured = env?.KARAOKE_FUNNEL_ORIGIN;
  return typeof configured === 'string' && configured.trim() !== ''
    ? configured.trim().replace(/\/+$/u, '')
    : DEFAULT_FUNNEL_ORIGIN;
}

export async function onRequest(context) {
  const upstream = new URL('/healthz', upstreamOrigin(context.env));
  const response = await fetch(upstream.toString(), {
    headers: {
      accept: 'application/json',
      'user-agent': context.request.headers.get('user-agent') ?? 'KaraokeDB-Cloudflare-Pages',
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
