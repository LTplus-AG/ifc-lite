/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { NotSignedInError } from '@ifc-lite/oauth-pkce';
import { validateConfig, type AutodeskServiceConfig } from './config.js';
import { Sessions, type Session } from './sessions.js';
import { ImportJobs } from './import-jobs.js';
import { apsResponse, boundedResponse, downloadSigned, ServiceError } from './upstream.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(400, 'invalid-request', 'Invalid Autodesk service request.');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 32_768) throw new ServiceError(400, 'invalid-request', 'Missing or invalid Autodesk reference.');
  return value;
}
function region(value: unknown): 'US' | 'EMEA' {
  if (value !== 'US' && value !== 'EMEA') throw new ServiceError(400, 'invalid-region', 'Choose US or EMEA.');
  return value;
}
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
}
export function createAutodeskHandler(config: AutodeskServiceConfig) {
  validateConfig(config);
  const sessions = new Sessions(config);
  const fetcher = config.fetch ?? fetch;
  const maxBytes = config.maxArtifactBytes ?? 512 * 1024 * 1024;
  const installed = config.adapters ?? [];
  const jobs = new ImportJobs(config.maxConcurrentImports ?? 2, maxBytes);
  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let session: Session | undefined;
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') return json({ ok: true, imports: installed.map((adapter) => adapter.kind) });
      if (url.origin !== config.origin || !url.pathname.startsWith('/api/autodesk/')) throw new ServiceError(404, 'not-found', 'Not found.');
      if (request.headers.get('sec-fetch-site') === 'cross-site' && url.pathname !== '/api/autodesk/callback') throw new ServiceError(403, 'cross-origin', 'Open Autodesk sources from this viewer.');
      session = sessions.get(request);
      if (request.method === 'GET' && url.pathname === '/api/autodesk/session') {
        session ??= sessions.create();
        let identity = null;
        if (session.identity) {
          try { identity = await sessions.identity(session); }
          catch (error) {
            if (error instanceof NotSignedInError || (error instanceof ServiceError && error.status === 401)) {
              sessions.discard(session); session = sessions.create();
            } else throw error;
          }
        }
        const response = json({ identity, csrf: session.csrf, imports: installed.map((adapter) => adapter.kind) });
        response.headers.set('Set-Cookie', sessions.cookie(session));
        return response;
      }
      if (!session) throw new ServiceError(401, 'sign-in-required', 'Sign in with Autodesk.');
      if (request.method === 'POST') {
        if (request.headers.get('origin') !== config.origin || request.headers.get('x-ifclite-csrf') !== session.csrf) throw new ServiceError(403, 'csrf', 'Refresh the viewer before trying again.');
      }
      if (request.method === 'POST' && url.pathname === '/api/autodesk/authorize') return json(await sessions.authorize(session));
      if (request.method === 'POST' && url.pathname === '/api/autodesk/cancel-signin') {
        sessions.cancelSignIn(session); return json({ cancelled: true });
      }
      if (request.method === 'POST' && url.pathname === '/api/autodesk/signout') {
        sessions.discard(session);
        const response = json({ signedOut: true }); response.headers.set('Set-Cookie', sessions.cookie()); return response;
      }
      if (request.method === 'GET' && url.pathname === '/api/autodesk/callback') {
        const signedIn = await sessions.callback(request, session);
        const target = new URL('/oauth/autodesk/callback', config.origin);
        target.searchParams.set('state', url.searchParams.get('state') ?? ''); target.searchParams.set('connected', '1');
        return new Response(null, { status: 303, headers: { Location: target.href, 'Set-Cookie': sessions.cookie(signedIn), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      if (!session.identity) throw new ServiceError(401, 'sign-in-required', 'Sign in with Autodesk.');
      const jobRoute = /^\/api\/autodesk\/imports\/([A-Za-z0-9_-]{32})(?:\/(artifact|cancel))?$/.exec(url.pathname);
      if (jobRoute) {
        const [, id, action] = jobRoute;
        if (request.method === 'POST' && action === 'cancel') { jobs.cancel(id, session); return json({ cancelled: true }); }
        if (request.method === 'GET' && !action) return json(jobs.status(id, session));
        if (request.method === 'GET' && action === 'artifact') {
          const { artifact, controller, release } = jobs.take(id, session);
          return ownedStream(new Response(new Uint8Array(artifact.bytes), { headers: {
            'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
            'X-IFClite-Revision': encodeURIComponent(artifact.revisionId), 'X-IFClite-Format': artifact.format,
          } }), session, controller, release);
        }
        throw new ServiceError(405, 'method-not-allowed', 'Unsupported import operation.');
      }
      const token = await session.tokens.getValidAccessToken();
      if (request.method === 'GET' && url.pathname === '/api/autodesk/request') {
        const response = await apsResponse(fetcher, string(url.searchParams.get('path')), token, region(url.searchParams.get('region')), request.signal);
        const controller = new AbortController();
        const value: unknown = await boundedResponse(response, 8 * 1024 * 1024, controller).json();
        if (!session.active) throw new ServiceError(401, 'signed-out', 'The Autodesk session ended.');
        return json(value);
      }
      if (request.method === 'GET' && url.pathname === '/api/autodesk/storage') {
        const storage = string(url.searchParams.get('id'));
        const match = /^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/.exec(storage);
        if (!match) throw new ServiceError(400, 'invalid-storage', 'Invalid Autodesk storage reference.');
        const controller = new AbortController(); session.operations.add(controller);
        const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(15 * 60_000)]);
        try {
          const signed = await apsResponse(fetcher, `/oss/v2/buckets/${encodeURIComponent(match[1])}/objects/${encodeURIComponent(match[2])}/signeds3download`, token, region(url.searchParams.get('region')), signal);
          const value = object(await signed.json());
          const response = boundedResponse(await downloadSigned(fetcher, value.url, signal), maxBytes, controller);
          // Keep session ownership until the stream is actually consumed/cancelled.
          return ownedStream(response, session, controller);
        } catch (error) { session.operations.delete(controller); throw error; }
      }
      if (request.method === 'POST' && url.pathname === '/api/autodesk/import') {
        if (Number(request.headers.get('content-length')) > 64_000) throw new ServiceError(413, 'request-limit', 'Import request is too large.');
        const raw = await request.text();
        if (raw.length > 64_000) throw new ServiceError(413, 'request-limit', 'Import request is too large.');
        const body = object(JSON.parse(raw)); const ref = object(body.ref);
        const adapter = installed.find((candidate) => candidate.kind === body.kind);
        if (!adapter) throw new ServiceError(503, 'import-unavailable', 'A native artifact adapter is not installed for this resource.');
        const id = jobs.start(session, adapter, { ref: {
          projectId: string(ref.projectId), containerId: string(ref.containerId), fileId: string(ref.fileId), revisionId: string(ref.revisionId),
        }, region: region(body.region), accessToken: token, signal: request.signal });
        return json({ id }, 202);
      }
      throw new ServiceError(404, 'not-found', 'Not found.');
    } catch (error) {
      const known = error instanceof ServiceError ? error : error instanceof NotSignedInError
        ? new ServiceError(401, 'sign-in-required', 'Sign in with Autodesk again.')
        : new ServiceError(502, 'service-failed', 'The Autodesk operation failed. Try again.');
      if (url.pathname === '/api/autodesk/callback') {
        // Log only our bounded failure category: never codes, state, cookies, tokens or upstream bodies.
        console.warn('Autodesk sign-in callback failed', known.code);
        const target = new URL('/oauth/autodesk/callback', config.origin);
        target.searchParams.set('state', url.searchParams.get('state') ?? ''); target.searchParams.set('error', known.code);
        return new Response(null, { status: 303, headers: { Location: target.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
      }
      return json({ code: known.code, message: known.message }, known.status);
    }
  };
  return Object.assign(handle, { close() { sessions.close(); jobs.close(); } });
}
function ownedStream(response: Response, session: Session, controller: AbortController, release?: () => void): Response {
  const reader = response.body!.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(output) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { session.operations.delete(controller); output.close(); release?.(); }
        else { if (!session.active || controller.signal.aborted) throw new ServiceError(401, 'signed-out', 'The Autodesk session ended.'); output.enqueue(chunk.value); }
      } catch (error) { session.operations.delete(controller); controller.abort(); output.error(error); release?.(); }
    },
    async cancel() { session.operations.delete(controller); controller.abort(); release?.(); await reader.cancel(); },
  }, { highWaterMark: 0 }), { headers: response.headers });
}
