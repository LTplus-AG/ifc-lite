/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CloudError, validateConfig, type CloudConfig, type Vendor } from './config.js';
import { CloudSessions } from './sessions.js';
import { requestJson } from './upstream.js';
import { readJson } from './bounded.js';
import { DownloadJobs } from './download-jobs.js';
const json = (value: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...Object.fromEntries(new Headers(headers)) } });
export function createCloudHandler(config: CloudConfig): { ready: Promise<void>; handle: (request: Request) => Promise<Response>; close: () => Promise<void> } {
  validateConfig(config); const sessions = new CloudSessions(config); const downloads = new DownloadJobs(sessions);
  return { ready: sessions.downloads.ready, close: () => sessions.close(), async handle(request) {
    await sessions.downloads.ready;
    const url = new URL(request.url);
    if (url.origin !== config.origin) return json({ error: 'not-found', message: 'Not found.' }, 404);
    if (url.pathname === '/healthz') return json({ ok: true });
    const route = /^\/api\/cloud\/(dropbox|msgraph)\/(session|authorize|callback|cancel-signin|signout|request|prepare-download|download-status|cancel-download|download)$/.exec(url.pathname);
    if (!route) return json({ error: 'not-found', message: 'Not found.' }, 404);
    const vendor = route[1] as Vendor; const action = route[2]; let session = sessions.get(request, vendor);
    if (action !== 'callback' && request.headers.get('sec-fetch-site') === 'cross-site') return json({ error: 'cross-origin', message: 'Open cloud sources from this viewer.' }, 403);
    try {
      if (action === 'callback' && request.method === 'GET') {
        const redirect = new URL(`/oauth/${vendor}/callback`, config.origin);
        const state = url.searchParams.get('state'); if (state) redirect.searchParams.set('state', state);
        try {
          if (!session) throw new CloudError(400, 'expired-transaction', 'Sign-in expired.');
          const signedIn = await sessions.callback(request, session);
          redirect.searchParams.set('connected', '1');
          return new Response(null, { status: 303, headers: { Location: redirect.href, 'Set-Cookie': sessions.cookie(vendor, signedIn), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
        } catch (error) {
          console.warn('Cloud sign-in failed', vendor, error instanceof CloudError ? error.code : 'oauth-failed');
          redirect.searchParams.set('error', 'access_denied');
          return new Response(null, { status: 303, headers: { Location: redirect.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
        }
      }
      if (action === 'session' && request.method === 'GET') {
        if (!session) session = sessions.create(vendor);
        if (session.identity) { try { await sessions.access(session); } catch (error) { if (!(error instanceof CloudError) || error.status !== 401) throw error; session = sessions.create(vendor); } }
        return json({ identity: session.identity ?? null, csrf: session.csrf, configured: Boolean(config.apps[vendor]) }, 200, { 'Set-Cookie': sessions.cookie(vendor, session) });
      }
      if (request.method !== 'POST') return json({ error: 'method-not-allowed', message: 'Method not allowed.' }, 405, { Allow: action === 'callback' || action === 'session' ? 'GET' : 'POST' });
      if (!session || request.headers.get('Origin') !== config.origin || request.headers.get('x-ifclite-csrf') !== session.csrf) throw new CloudError(403, 'csrf', 'Cloud request verification failed.');
      if (action === 'authorize') return json(await sessions.authorize(session));
      if (action === 'cancel-signin') { sessions.cancel(session); return json({ ok: true }); }
      if (action === 'signout') { sessions.discard(session); return json({ ok: true }, 200, { 'Set-Cookie': sessions.cookie(vendor) }); }
      if (!['request', 'prepare-download', 'download-status', 'cancel-download', 'download'].includes(action ?? '')) throw new CloudError(405, 'method-not-allowed', 'Method not allowed.');
      if (!session.identity) throw new CloudError(401, 'signed-out', 'Sign in again.');
      if (!request.headers.get('content-type')?.startsWith('application/json')) throw new CloudError(415, 'content-type', 'JSON is required.');
      let raw: unknown;
      try { raw = await readJson(new Response(request.body), 64 * 1024); }
      catch (error) { if (error instanceof CloudError && error.code === 'invalid-json') throw new CloudError(400, 'invalid-request', 'The cloud request must contain valid JSON.'); throw error; }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CloudError(400, 'invalid-request', 'Invalid cloud operation.');
      if (action === 'download-status' || action === 'cancel-download' || action === 'download') {
        if (!('jobId' in raw) || typeof raw.jobId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw.jobId)) throw new CloudError(400, 'invalid-request', 'A download job is required.');
        if (action === 'download-status') return json(downloads.status(session, raw.jobId));
        if (action === 'cancel-download') { downloads.cancel(session, raw.jobId); return json({ ok: true }); }
        return downloads.claim(session, raw.jobId, request.signal);
      }
      if (!('path' in raw) || typeof raw.path !== 'string') throw new CloudError(400, 'invalid-request', 'A cloud operation path is required.');
      const body = raw as { path: string; args?: unknown; params?: Record<string, string | number>; revision?: string };
      if (body.params && (typeof body.params !== 'object' || Object.values(body.params).some(v => typeof v !== 'string' && typeof v !== 'number'))) throw new CloudError(400, 'invalid-request', 'Invalid cloud parameters.');
      if (body.revision !== undefined && typeof body.revision !== 'string') throw new CloudError(400, 'invalid-request', 'Invalid revision.');
      if (action === 'prepare-download') return json({ jobId: downloads.start(session, body) }, 202);
      const op = sessions.operation(session, 30_000, request.signal);
      try { return json(await requestJson(sessions, session, body, op.signal)); }
      finally { op.done(); }
    } catch (error) {
      if (error instanceof CloudError) return json({ error: error.code, message: error.message }, error.status);
      console.warn('Cloud request failed', vendor, 'request-failed');
      return json({ error: 'request-failed', message: 'Cloud request could not be completed. Try again.' }, 502);
    }
  } };
}
