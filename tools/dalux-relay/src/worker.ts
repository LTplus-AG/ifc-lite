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
    const cors = resolveCors(request.headers.get('Origin'), env.ALLOWED_ORIGINS);
    if ('error' in cors) {
      return cors.error;
    }
    const { corsHeaders } = cors;

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
      body: request.method === 'POST' ? request.body : undefined,
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

function resolveCors(
  origin: string | null,
  allowedOrigins?: string,
): { corsHeaders: Record<string, string> } | { error: Response } {
  const allowed = parseAllowedOrigins(allowedOrigins);
  if (allowed.length === 0) {
    return {
      error: jsonError(
        500,
        'ALLOWED_ORIGINS is not configured. Configure a comma-separated allowlist before deploying this relay.',
        {},
      ),
    };
  }

  if (allowed.includes('*')) {
    return { corsHeaders: buildCorsHeaders('*') };
  }

  if (!origin || !allowed.includes(origin)) {
    return {
      error: jsonError(403, `Origin not allowed: ${origin ?? '(missing origin)'}`, {}),
    };
  }

  return { corsHeaders: buildCorsHeaders(origin) };
}

function parseAllowedOrigins(allowedOrigins?: string): string[] {
  return (allowedOrigins ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
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
