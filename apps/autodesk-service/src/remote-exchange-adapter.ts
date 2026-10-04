/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NativeArtifactAdapter } from './config.js';
import { boundedResponse, ServiceError } from './upstream.js';
import { validateWorkerKey } from './worker-auth.js';

export function remoteExchangeAdapter(origin: string, key: string, fetcher = fetch, maxBytes = 512 * 1024 * 1024): NativeArtifactAdapter {
  const base = new URL(origin);
  if (base.origin !== origin || base.protocol !== 'https:' || base.username || base.password) throw new Error('AUTODESK_EXCHANGE_WORKER_ORIGIN must be an exact HTTPS origin.');
  validateWorkerKey(key);
  const call = async (path: string, signal: AbortSignal, body?: unknown): Promise<Response> => {
    const response = await fetcher(new URL(path, base), { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(path.endsWith('/artifact') ? 15 * 60_000 : 30_000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceError(response.status === 429 ? 429 : 502, 'exchange-worker-failed', 'The exchange worker is unavailable or refused this revision. Refresh and retry.');
    }
    return response;
  };
  const json = async (response: Response): Promise<unknown> => JSON.parse(await boundedResponse(response, 64_000, new AbortController()).text()) as unknown;
  return { kind: 'exchange', async convert(input) {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(15 * 60_000)]);
    let id: string | undefined;
    let consumed = false;
    try {
      const response = await call('/api/exchange-worker/imports', signal, { ref: input.ref, region: input.region, accessToken: input.accessToken });
      const result: unknown = await json(response);
      if (response.status !== 202 || !result || typeof result !== 'object' || !('id' in result) ||
          typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(result.id)) throw new ServiceError(502, 'invalid-worker-job', 'The exchange worker returned an invalid job.');
      id = result.id;
      while (true) {
        const status: unknown = await json(await call(`/api/exchange-worker/imports/${id}`, signal));
        if (!status || typeof status !== 'object' || !('state' in status) || !['preparing', 'ready'].includes(String(status.state))) throw new ServiceError(502, 'invalid-worker-state', 'The exchange worker returned an invalid state.');
        if (status.state === 'ready') break;
        await pause(signal);
      }
      const artifact = await call(`/api/exchange-worker/imports/${id}/artifact`, signal);
      consumed = true;
      if (artifact.headers.get('x-ifclite-revision') !== encodeURIComponent(input.ref.revisionId) || artifact.headers.get('x-ifclite-format') !== 'ifc') {
        await artifact.body?.cancel();
        throw new ServiceError(502, 'revision-mismatch', 'The exchange worker returned another revision.');
      }
      const bytes = new Uint8Array(await boundedResponse(artifact, maxBytes, new AbortController()).arrayBuffer());
      if (!Buffer.from(bytes.subarray(0, 64)).toString().includes('ISO-10303-21')) throw new ServiceError(502, 'invalid-ifc', 'The exchange worker returned invalid IFC.');
      return { revisionId: input.ref.revisionId, format: 'ifc', bytes };
    } finally {
      if (id && !consumed) {
        try { await call(`/api/exchange-worker/imports/${id}/cancel`, AbortSignal.timeout(10_000), {}); }
        catch (error) { console.warn('Exchange worker cleanup failed', error instanceof Error ? error.name : 'Unknown error'); }
      }
    }
  } };
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
