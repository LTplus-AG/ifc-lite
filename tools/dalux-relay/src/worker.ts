/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cloudflare Worker that relays requests to the Dalux Build API, injecting
 * the API key server-side and adding CORS headers.
 *
 * Route: POST /relay?url=<encoded-dalux-url>  →  forwards to Dalux
 * Preflight: OPTIONS /relay                    →  CORS preflight response
 */

interface Env {
  DALUX_API_KEY: string;
  ALLOWED_ORIGINS?: string;
}

const DALUX_HOST = 'field.dalux.com';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '*';
    const corsHeaders = buildCorsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return jsonError(400, 'Missing ?url= parameter', corsHeaders);
    }

    let parsed: URL;
    try {
      parsed = new URL(target);
    } catch {
      return jsonError(400, 'Invalid target URL', corsHeaders);
    }

    if (parsed.hostname !== DALUX_HOST) {
      return jsonError(403, `Only ${DALUX_HOST} is allowed`, corsHeaders);
    }

    if (!env.DALUX_API_KEY) {
      return jsonError(500, 'DALUX_API_KEY secret not configured', corsHeaders);
    }

    const upstream = await fetch(parsed.toString(), {
      method: request.method === 'POST' ? 'POST' : 'GET',
      headers: {
        'X-API-Key': env.DALUX_API_KEY,
        Accept: 'application/json',
      },
    });

    const responseHeaders = new Headers(upstream.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      responseHeaders.set(k, v);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};

function buildCorsHeaders(
  origin: string,
  allowedOrigins?: string,
): Record<string, string> {
  const allowed = allowedOrigins
    ? allowedOrigins.split(',').map((s) => s.trim())
    : ['*'];

  const effectiveOrigin = allowed.includes('*')
    ? '*'
    : allowed.includes(origin)
      ? origin
      : allowed[0]!;

  return {
    'Access-Control-Allow-Origin': effectiveOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonError(
  status: number,
  message: string,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
