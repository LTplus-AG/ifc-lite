/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared decode worker dying (crash, OOM, unreadable reply) or a post
 * throwing must settle every pending request and evict the shared session,
 * so the next point-cloud load spawns a fresh worker instead of hanging on
 * the dead one (P3, implicit-state-machines audit).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetSharedSessionForTests,
  createDecodeWorkerSource,
  getSharedSession,
} from './worker-client.js';

type Listener = (event: { data?: unknown; message?: string }) => void;

/** A fake worker that can crash, send an unreadable reply, or refuse a post. */
function fakeWorker() {
  const listeners = new Map<string, Listener[]>();
  const sent: Array<Record<string, unknown>> = [];
  let throwOnPost: Error | null = null;
  const state = { terminated: false };
  const worker = {
    postMessage: (msg: Record<string, unknown>) => {
      if (throwOnPost) throw throwOnPost;
      sent.push(msg);
    },
    addEventListener: (type: string, l: Listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), l]);
    },
    removeEventListener: (type: string, l: Listener) => {
      listeners.set(type, (listeners.get(type) ?? []).filter((x) => x !== l));
    },
    terminate: () => { state.terminated = true; },
  };
  const emit = (type: string, event: { data?: unknown; message?: string }) => {
    for (const l of listeners.get(type) ?? []) l(event);
  };
  return {
    sent,
    state,
    worker: worker as unknown as Worker,
    crash: (message = 'out of memory') => emit('error', { message }),
    unreadable: () => emit('messageerror', {}),
    reply: (data: unknown) => emit('message', { data }),
    refusePosts: (err: Error | null) => { throwOnPost = err; },
    lastRequest: (kind: string) => [...sent].reverse().find((m) => m.kind === kind) as { requestId: number } | undefined,
  };
}

const INFO = { totalPointCount: 1, bbox: { min: [0, 0, 0], max: [0, 0, 0] }, hasColor: false, hasClassification: false, hasIntensity: false };

describe('decode worker death (P3)', () => {
  beforeEach(() => {
    __resetSharedSessionForTests();
  });

  it('P3: a worker crash mid-open rejects the pending open instead of hanging', async () => {
    const w = fakeWorker();
    const source = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn: () => w.worker });
    const opening = source.open();
    await vi.waitFor(() => expect(w.lastRequest('open')).toBeDefined());
    w.crash('out of memory');
    await expect(opening).rejects.toThrow(/out of memory/);
    expect(w.state.terminated).toBe(true);
  });

  it('P3: an unreadable reply (messageerror) rejects every pending request', async () => {
    const w = fakeWorker();
    const a = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn: () => w.worker });
    const b = createDecodeWorkerSource({ format: 'ply', blob: new Blob([]), spawn: () => w.worker });
    const openingA = a.open();
    const openingB = b.open();
    await vi.waitFor(() => expect(w.sent.filter((m) => m.kind === 'open')).toHaveLength(2));
    w.unreadable();
    await expect(openingA).rejects.toThrow(/could not be read/);
    await expect(openingB).rejects.toThrow(/could not be read/);
    expect(w.state.terminated).toBe(true);
  });

  it('P3: a crash mid-decode rejects the pending next(), and later calls reject at once', async () => {
    const w = fakeWorker();
    const source = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn: () => w.worker });
    const opening = source.open();
    await vi.waitFor(() => expect(w.lastRequest('open')).toBeDefined());
    w.reply({ kind: 'opened', requestId: w.lastRequest('open')!.requestId, sourceId: 3, info: INFO });
    await opening;
    const decoding = source.next(100);
    await vi.waitFor(() => expect(w.lastRequest('next')).toBeDefined());
    w.crash('boom');
    await expect(decoding).rejects.toThrow(/boom/);
    const posted = w.sent.length;
    await expect(source.next(100)).rejects.toThrow(/boom/);
    expect(w.sent.length).toBe(posted);
    // close() on a source whose worker died must not throw.
    expect(() => source.close()).not.toThrow();
  });

  it('P3: the shared session is evicted on death so the next load spawns a fresh worker', async () => {
    const dead = fakeWorker();
    const fresh = fakeWorker();
    const spawn = vi.fn().mockReturnValueOnce(dead.worker).mockReturnValueOnce(fresh.worker);
    const first = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn });
    const opening = first.open();
    await vi.waitFor(() => expect(dead.lastRequest('open')).toBeDefined());
    dead.crash();
    await expect(opening).rejects.toThrow();

    const second = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn });
    const reopening = second.open();
    await vi.waitFor(() => expect(fresh.lastRequest('open')).toBeDefined());
    fresh.reply({ kind: 'opened', requestId: fresh.lastRequest('open')!.requestId, sourceId: 1, info: INFO });
    await expect(reopening).resolves.toEqual(INFO);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('P3: retrying open() on the same never-opened source after a crash uses a fresh worker', async () => {
    const dead = fakeWorker();
    const fresh = fakeWorker();
    const spawn = vi.fn().mockReturnValueOnce(dead.worker).mockReturnValueOnce(fresh.worker);
    const source = createDecodeWorkerSource({ format: 'las', blob: new Blob([]), spawn });
    const opening = source.open();
    await vi.waitFor(() => expect(dead.lastRequest('open')).toBeDefined());
    dead.crash();
    await expect(opening).rejects.toThrow();
    const retry = source.open();
    await vi.waitFor(() => expect(fresh.lastRequest('open')).toBeDefined());
    fresh.reply({ kind: 'opened', requestId: fresh.lastRequest('open')!.requestId, sourceId: 1, info: INFO });
    await expect(retry).resolves.toEqual(INFO);
  });

  it('P3: a throwing postMessage rejects that request and leaves the session usable', async () => {
    const w = fakeWorker();
    const session = await getSharedSession(() => w.worker);
    w.refusePosts(new DOMException('could not be cloned', 'DataCloneError'));
    await expect(session.send(
      (requestId) => ({ kind: 'next', requestId, sourceId: 1, maxPoints: 1 }),
    )).rejects.toThrow(/could not be cloned/);
    w.refusePosts(null);
    const ok = session.send((requestId) => ({ kind: 'next', requestId, sourceId: 1, maxPoints: 1 }));
    const { requestId } = w.lastRequest('next')!;
    w.reply({ kind: 'chunk', requestId, chunk: null });
    await expect(ok).resolves.toMatchObject({ kind: 'chunk', chunk: null });
    expect(w.state.terminated).toBe(false);
    // Still the cached session: a refused post is not a dead worker.
    await expect(getSharedSession(() => { throw new Error('must not respawn'); })).resolves.toBe(session);
  });
});
