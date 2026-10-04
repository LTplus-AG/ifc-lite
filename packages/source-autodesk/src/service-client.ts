/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readWithProgress } from '@ifc-lite/plugin-api';
import { AutodeskError, checkResponse, optionalText, record, text, type AutodeskService } from './api.js';
import { parseAddress } from './refs.js';

function waitForImport(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

/** Host installs this explicitly; fixed same-origin route, no generic cookie proxy. */
export function createAutodeskService(fetcher: typeof fetch = fetch): AutodeskService {
  let csrf: string | undefined;
  let imports: ('exchange' | 'proposal')[] = [];
  const call = async (path: string, init?: RequestInit): Promise<Response> => {
    const response = await fetcher(`/api/autodesk/${path}`, { ...init, credentials: 'same-origin', redirect: 'error', cache: 'no-store' });
    if (!response.ok) {
      let message: string | undefined;
      try { message = optionalText(record(await response.json()).message); }
      catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        throw new AutodeskError(`service-${response.status}`, 'The Autodesk service is unavailable. Check deployment configuration.', response.status);
      }
      if (message) throw new AutodeskError(`service-${response.status}`, message, response.status);
      checkResponse(response);
    }
    return response;
  };
  const session = async (signal?: AbortSignal) => {
    const value = record(await (await call('session', { signal })).json());
    csrf = text(value.csrf, 'session CSRF token');
    imports = Array.isArray(value.imports) ? value.imports.filter((kind): kind is 'exchange' | 'proposal' => kind === 'exchange' || kind === 'proposal') : [];
    if (value.identity === null) return null;
    const identity = record(value.identity);
    return { id: text(identity.id), displayName: optionalText(identity.displayName), email: optionalText(identity.email) };
  };
  const mutation = async (path: string, body?: unknown, signal?: AbortSignal) => {
    if (!csrf) await session(signal);
    return call(path, { method: 'POST', signal, headers: { 'X-IFClite-CSRF': csrf ?? '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  return {
    get imports() { return imports; },
    identity: session,
    async startSignIn(signal) {
      const value = record(await (await mutation('authorize', undefined, signal)).json());
      const url = new URL(text(value.url));
      if (url.origin !== 'https://developer.api.autodesk.com' || url.pathname !== '/authentication/v2/authorize') throw new AutodeskError('invalid-authorization', 'The service returned an unexpected sign-in URL.');
      return { url: url.href, state: text(value.state) };
    },
    async cancelSignIn() { await mutation('cancel-signin'); },
    async signOut() { await mutation('signout'); csrf = undefined; imports = []; },
    async request(path, region, signal) {
      return (await call(`request?${new URLSearchParams({ path, region })}`, { signal })).json() as Promise<unknown>;
    },
    async downloadStorage(id, region, options) {
      options?.onPhase?.('downloading');
      const response = await call(`storage?${new URLSearchParams({ id, region })}`, { signal: options?.signal });
      return readWithProgress(response, options?.onProgress);
    },
    async importResource(ref, region, options) {
      const kind = parseAddress(ref.projectId).kind === 'site' ? 'proposal' : 'exchange';
      const controller = new AbortController();
      const caller = options?.signal;
      const abort = () => controller.abort(caller?.reason);
      caller?.addEventListener('abort', abort, { once: true });
      if (caller?.aborted) abort();
      const timer = setTimeout(() => controller.abort(new AutodeskError('import-timeout', 'Autodesk import timed out. Try again.')), 15 * 60_000);
      let id: string | undefined;
      let consumed = false;
      try {
        options?.onPhase?.('preparing');
        const prepared = record(await (await mutation('import', { kind, ref, region }, controller.signal)).json());
        const candidate = text(prepared.id, 'import job');
        if (!/^[A-Za-z0-9_-]{32}$/.test(candidate)) throw new AutodeskError('invalid-import', 'The service returned an invalid import reference.');
        id = candidate;
        while (true) {
          controller.signal.throwIfAborted();
          const status = record(await (await call(`imports/${id}`, { signal: controller.signal })).json());
          if (status.state === 'ready') break;
          if (status.state !== 'preparing') throw new AutodeskError('invalid-import', 'The import returned an unexpected state.');
          await waitForImport(controller.signal);
        }
        const response = await call(`imports/${id}/artifact`, { signal: controller.signal });
        consumed = true;
        if (response.headers.get('x-ifclite-revision') !== encodeURIComponent(ref.revisionId ?? '') ||
            response.headers.get('x-ifclite-format') !== (kind === 'proposal' ? 'ifcx' : 'ifc')) {
          await response.body?.cancel();
          throw new AutodeskError('invalid-artifact', 'The prepared model does not match the requested revision or format.');
        }
        options?.onPhase?.('downloading');
        return await readWithProgress(response, options?.onProgress);
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        clearTimeout(timer);
        caller?.removeEventListener('abort', abort);
        if (id && !consumed) {
          try { await mutation(`imports/${id}/cancel`, undefined, AbortSignal.timeout(5000)); }
          catch (error) {
            if (!(error instanceof AutodeskError && [401, 404].includes(error.status ?? 0))) {
              console.warn('Autodesk import cleanup failed', error instanceof Error ? error.name : 'Unknown error');
            }
          }
        }
      }
    },
  };
}
