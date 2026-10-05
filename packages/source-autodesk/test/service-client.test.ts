/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it, vi } from 'vitest';
import { createAutodeskService } from '../src/service-client.js';
import { address } from '../src/refs.js';

it('restarts sign-in after the restored gateway session expires (#6905)', async () => {
  let generation = 1;
  const authorizations: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return Response.json({ csrf: `session-${generation}`, identity: null });
    if (path.endsWith('/authorize')) {
      const csrf = new Headers(init?.headers).get('X-IFClite-CSRF');
      if (csrf !== `session-${generation}`) return Response.json({ message: 'Sign in with Autodesk.' }, { status: 401 });
      authorizations.push(csrf);
      return Response.json({ url: 'https://developer.api.autodesk.com/authentication/v2/authorize', state: 'transaction' });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  const service = createAutodeskService(fetcher);
  await service.identity();
  generation++; // Gateway idle expiry or restart invalidates the old session.
  await service.startSignIn();
  generation++;
  await service.startSignIn();
  expect(authorizations).toEqual(['session-2', 'session-3']);
});

it('does not authorize when sign-in is cancelled during session discovery (#6905)', async () => {
  const controller = new AbortController(); let authorized = false;
  const fetcher: typeof fetch = async (input) => {
    if (String(input).endsWith('/session')) {
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      return Response.json({ csrf: 'session', identity: null });
    }
    authorized = true;
    throw new Error('Authorization must not run after cancellation');
  };
  await expect(createAutodeskService(fetcher).startSignIn(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(authorized).toBe(false);
});

it('can sign out after the previously restored gateway session disappears (#6905)', async () => {
  let generation = 1; let discarded = false;
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/session')) return Response.json({ csrf: `session-${generation}`, identity: generation === 1 ? { id: 'account' } : null, imports: ['exchange'] });
    if (String(input).endsWith('/signout')) {
      if (new Headers(init?.headers).get('X-IFClite-CSRF') !== `session-${generation}`) return Response.json({ message: 'Sign in with Autodesk.' }, { status: 401 });
      discarded = true; return Response.json({ signedOut: true });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };
  const service = createAutodeskService(fetcher);
  await service.identity(); generation++;
  await service.signOut();
  expect(discarded).toBe(true); expect(service.imports).toEqual([]);
});

const id = 'a'.repeat(32);
const ref = {
  projectId: address({ kind: 'project', project: 'project', region: 'EMEA' }),
  containerId: 'folder', fileId: 'item', revisionId: 'version',
};

function stalledService() {
  let entered: () => void = () => { throw new Error('Not initialized'); };
  const statusEntered = new Promise<void>((resolve) => { entered = resolve; });
  const canceled: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path.endsWith('/session')) return Response.json({ csrf: 'csrf', identity: null, imports: ['exchange'] });
    if (path.endsWith('/import')) return Response.json({ id });
    if (path.endsWith('/cancel')) { canceled.push(path); return Response.json({ ok: true }); }
    if (path.endsWith(`/imports/${id}`)) {
      entered();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return { service: createAutodeskService(fetcher), statusEntered, canceled };
}

it('bounds a stalled import status request and cancels its server job (#6825)', async () => {
  vi.useFakeTimers();
  try {
    const h = stalledService();
    const outcome = h.service.importResource(ref, 'EMEA').catch((error: unknown) => error);
    await h.statusEntered;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(await outcome).toMatchObject({ code: 'import-timeout', message: 'Autodesk import timed out. Try again.' });
    expect(h.canceled).toEqual([`/api/autodesk/imports/${id}/cancel`]);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it('preserves caller cancellation and releases a prepared import job (#6825)', async () => {
  const h = stalledService();
  const controller = new AbortController();
  const reason = new DOMException('Canceled by user', 'AbortError');
  const outcome = h.service.importResource(ref, 'EMEA', { signal: controller.signal }).catch((error: unknown) => error);
  await h.statusEntered;
  controller.abort(reason);
  expect(await outcome).toBe(reason);
  expect(h.canceled).toEqual([`/api/autodesk/imports/${id}/cancel`]);
});

it('returns revision-checked artifact bytes and clears the import deadline (#6825)', async () => {
  vi.useFakeTimers();
  try {
    const fetcher: typeof fetch = async (input) => {
      const path = String(input);
      if (path.endsWith('/session')) return Response.json({ csrf: 'csrf', identity: null, imports: ['exchange'] });
      if (path.endsWith('/import')) return Response.json({ id });
      if (path.endsWith(`/imports/${id}`)) return Response.json({ state: 'ready' });
      if (path.endsWith('/artifact')) return new Response('ISO-10303-21;', { headers: {
        'x-ifclite-revision': 'version', 'x-ifclite-format': 'ifc',
      } });
      throw new Error(`Unexpected request: ${path}`);
    };
    const phases: string[] = [];
    const bytes = await createAutodeskService(fetcher).importResource(ref, 'EMEA', { onPhase: (phase) => phases.push(phase) });
    expect(new TextDecoder().decode(bytes)).toBe('ISO-10303-21;');
    expect(phases).toEqual(['preparing', 'downloading']);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
