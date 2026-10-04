/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NativeArtifactAdapter } from './config.js';
import { ImportJobs } from './import-jobs.js';
import { ServiceError } from './upstream.js';
import { authorizedWorker, validateWorkerKey } from './worker-auth.js';

/** Only the authenticated gateway can submit delegated tokens or retrieve jobs. */
export function createExchangeWorkerHandler(key: string, adapter: NativeArtifactAdapter, maxBytes = 512 * 1024 * 1024) {
  validateWorkerKey(key);
  if (adapter.kind !== 'exchange') throw new Error('The remote worker must use the exchange adapter.');
  const owner = { active: true, operations: new Set<AbortController>() };
  const jobs = new ImportJobs(2, maxBytes);
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  const handle = async (request: Request): Promise<Response> => {
    try {
      const path = new URL(request.url).pathname;
      if (!authorizedWorker(request, key)) return json({ code: 'unauthorized' }, 401);
      if (path === '/healthz' && request.method === 'GET') return json({ ok: true, protocol: 1, imports: ['exchange'] });
      if (path === '/api/exchange-worker/imports' && request.method === 'POST') {
        if (Number(request.headers.get('content-length')) > 64_000) throw new ServiceError(413, 'request-limit', 'Request too large.');
        const raw = await request.text();
        if (Buffer.byteLength(raw) > 64_000) throw new ServiceError(413, 'request-limit', 'Request too large.');
        const body: unknown = JSON.parse(raw);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError(400, 'invalid-request', 'Invalid request.');
        const data = body as Record<string, unknown>;
        if (!data.ref || typeof data.ref !== 'object' || Array.isArray(data.ref)) throw new ServiceError(400, 'invalid-reference', 'Invalid reference.');
        const ref = data.ref as Record<string, unknown>;
        const value = (item: unknown) => {
          if (typeof item !== 'string' || !item || item.length > 16_384) throw new ServiceError(400, 'invalid-reference', 'Invalid reference.');
          return item;
        };
        if (data.region !== 'US' && data.region !== 'EMEA') throw new ServiceError(400, 'invalid-region', 'Invalid region.');
        const id = jobs.start(owner, adapter, { ref: { projectId: value(ref.projectId), containerId: value(ref.containerId),
          fileId: value(ref.fileId), revisionId: value(ref.revisionId) }, region: data.region,
          accessToken: value(data.accessToken), signal: request.signal });
        return json({ id }, 202);
      }
      const match = /^\/api\/exchange-worker\/imports\/([A-Za-z0-9_-]{32})(?:\/(artifact|cancel))?$/.exec(path);
      if (!match) return json({ code: 'not-found' }, 404);
      const [, id, action] = match;
      if (request.method === 'GET' && !action) return json(jobs.status(id, owner));
      if (request.method === 'POST' && action === 'cancel') { jobs.cancel(id, owner); return json({ cancelled: true }); }
      if (request.method === 'GET' && action === 'artifact') {
        const { artifact, controller, release } = jobs.take(id, owner);
        let offset = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(output) {
            if (controller.signal.aborted) { output.error(new Error('Import expired.')); release(); }
            else if (offset === artifact.bytes.byteLength) { output.close(); release(); }
            else { const end = Math.min(offset + 64 * 1024, artifact.bytes.byteLength); output.enqueue(artifact.bytes.subarray(offset, end)); offset = end; }
          },
          cancel() { release(); },
        }, { highWaterMark: 0 }), { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/octet-stream',
          'X-IFClite-Revision': encodeURIComponent(artifact.revisionId), 'X-IFClite-Format': 'ifc' } });
      }
      return json({ code: 'method-not-allowed' }, 405);
    } catch (error) {
      const known = error instanceof ServiceError ? error : error instanceof SyntaxError ? new ServiceError(400, 'invalid-request', 'Invalid JSON request.') : new ServiceError(502, 'worker-failed', 'The exchange worker failed.');
      return json({ code: known.code, message: known.message }, known.status);
    }
  };
  return Object.assign(handle, { async close() { owner.active = false; await jobs.close(); } });
}
