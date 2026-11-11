/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared by the scene-snapshot write and cold-capture tests: a committed cache
 * entry to attach to, the snapshot bytes each IndexedDB put received, a real
 * recording load trace, and an idle callback that fires at once.
 *
 * Import after `fake-indexeddb/auto` and `@/test/setup-dom.js`.
 */

import assert from 'node:assert/strict';
import { createLoadTracer, type LoadTrace } from '@ifc-lite/load-trace';
import { decodeSceneSnapshot } from '@ifc-lite/renderer';
import { setCached } from '../services/ifc-cache.js';
import type { SnapshotEntry } from '../hooks/sceneSnapshotWrite.js';

/** A committed entry for `key`, with a shard section location to carry into the snapshot. */
export async function entryOf(key: string): Promise<SnapshotEntry> {
  const write = await setCached(key, new ArrayBuffer(64), `${key}.ifc`, 64, undefined, { fullSourceHash: 'h' });
  assert.ok(write, 'the entry write committed');
  return { cacheKey: key, write, shards: { offset: 16, size: 8 } };
}

export async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The snapshot Blob each put hands IndexedDB, by entry key. fake-indexeddb
 * returns a structured clone of happy-dom's Blob, which has no `arrayBuffer`,
 * so the bytes are read from here.
 */
export const putSnapshots = new Map<string, Blob>();
const storeProto = (globalThis as unknown as { IDBObjectStore: { prototype: { put: (value: unknown, key?: unknown) => unknown } } }).IDBObjectStore.prototype;
const originalPut = storeProto.put;
storeProto.put = function put(this: unknown, value: unknown, key?: unknown) {
  const entry = value as { key?: string; sceneSnapshot?: Blob };
  if (entry?.key && entry.sceneSnapshot) putSnapshots.set(entry.key, entry.sceneSnapshot);
  return originalPut.call(this, value, key);
};

export async function storedSnapshot(key: string) {
  const blob = putSnapshots.get(key);
  return blob ? decodeSceneSnapshot(await blob.arrayBuffer()) : null;
}

/** A recording trace and the `cache.writeSceneSnapshot` outcomes (and reasons) it ended with, in order. */
export function snapshotTrace(): { trace: LoadTrace; outcomes: () => string[] } {
  const tracer = createLoadTracer({ enabled: true, sink: null });
  const trace = tracer.startLoad('w2');
  return {
    trace,
    outcomes: () => (tracer.latest()?.spans ?? []).filter((s) => s.name === 'cache.writeSceneSnapshot' && s.end !== null)
      .map((s) => [s.attrs?.outcome, s.attrs?.reason].filter((v) => v !== undefined).join(':')),
  };
}

let originalIdle: typeof window.requestIdleCallback | undefined;
/** Idle periods arrive at once; restore with {@link restoreIdle}. */
export function immediateIdle(): void {
  originalIdle = window.requestIdleCallback;
  window.requestIdleCallback = ((cb: IdleRequestCallback) => Number(setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0))) as typeof window.requestIdleCallback;
}
export function restoreIdle(): void {
  if (originalIdle) window.requestIdleCallback = originalIdle;
}
