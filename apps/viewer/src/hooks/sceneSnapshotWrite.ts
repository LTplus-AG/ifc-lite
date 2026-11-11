/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Writing a captured finished scene beside its cache entry, after the load.
 *
 * The capture is taken at the load's finalize swap and is already frozen: it
 * holds the merged arrays that finalize uploaded, which nothing else keeps, so
 * an edit, recolour, section or federated add after the load cannot change it
 * and nothing is cloned. What is deferred is only the encode (a Blob copy of
 * the batch bytes) and the IndexedDB write. They wait for the load to be
 * interactive and for an idle period, run in slices, and are dropped when
 * another file opens. A hidden tab writes at once, since nobody is waiting on
 * its frames. The pending write is the trace span `cache.writeSceneSnapshot`,
 * so harnesses that wait for `cache.write*` spans wait for it too.
 */

import { encodeSceneSnapshotInSlices, type SceneSnapshot } from '@ifc-lite/renderer';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { useViewerStore } from '../store/index.js';
import { putSceneSnapshot, type SceneSnapshotWrite } from '../services/cacheService.js';
import type { SnapshotCameraFit } from '../components/viewer/sceneSnapshotOwnership.js';

/** A finished scene as the finalize swap left it, with what a reopen needs to draw it. */
export interface CapturedScene {
  snapshot: SceneSnapshot;
  fit: SnapshotCameraFit;
  /** `sceneSnapshotKey` at the swap: the type visibility the batches were built under. */
  key: string;
}

/** The cache entry write a snapshot belongs to. */
export interface SnapshotEntry {
  cacheKey: string;
  write: SceneSnapshotWrite;
  /** Where the entry keeps its instanced shards, which a snapshot reopen reads directly. */
  shards: { offset: number; size: number } | null;
}

export type SnapshotWriteOutcome = 'written' | 'refused' | 'abandoned' | 'no-entry';

const STALE_POLL_MS = 250;
const IDLE_TIMEOUT_MS = 2000;
/** A load whose entry write never reported back keeps its capture this long at most. */
const ENTRY_WAIT_LIMIT_MS = 10 * 60 * 1000;

const pageHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** A macrotask that background throttling does not clamp, unlike setTimeout in a hidden tab. */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') { setTimeout(resolve, 0); return; }
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); resolve(); };
    channel.port2.postMessage(null);
  });
}

/** True once the load that owns the write is no longer current (or `until` overran its limit); false when `until` settles first. */
function supersession(isStale: () => boolean, until: Promise<unknown>): Promise<boolean> {
  if (isStale()) return Promise.resolve(true);
  const deadline = performance.now() + ENTRY_WAIT_LIMIT_MS;
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!isStale() && performance.now() < deadline) return;
      clearInterval(timer);
      resolve(true);
    }, STALE_POLL_MS);
    void until.finally(() => { clearInterval(timer); resolve(isStale()); });
  });
}

/** Resolves when the store no longer reports a load or a geometry stream in progress. */
export function whenLoadInteractive(): Promise<void> {
  const settled = () => {
    const { loading, geometryStreamingActive } = useViewerStore.getState();
    return !loading && !geometryStreamingActive;
  };
  if (settled()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useViewerStore.subscribe(() => {
      if (!settled()) return;
      unsubscribe();
      resolve();
    });
  });
}

/** The next idle period, or at once in a hidden tab (also when the tab is hidden while waiting). */
export function idlePeriod(timeoutMs = IDLE_TIMEOUT_MS): Promise<void> {
  if (pageHidden() || typeof window === 'undefined') return yieldToHost();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('visibilitychange', onHidden);
      resolve();
    };
    const onHidden = () => { if (pageHidden()) finish(); };
    document.addEventListener('visibilitychange', onHidden);
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(finish, { timeout: timeoutMs });
    else setTimeout(finish, timeoutMs);
  });
}

/** One idle slice before each piece of work, unless the tab is hidden. */
async function sliceGap(): Promise<void> {
  if (pageHidden()) return yieldToHost();
  return idlePeriod(500);
}

/**
 * Encode and store `captured` beside `entry` once the load is interactive and
 * the page idle. Ends the trace span `span` (begun by the caller at the swap).
 */
export async function writeCapturedScene(
  captured: CapturedScene,
  entry: Promise<SnapshotEntry | null>,
  isStale: () => boolean,
  trace: LoadTrace,
  span: number,
): Promise<SnapshotWriteOutcome> {
  const finish = (outcome: SnapshotWriteOutcome, attrs: Record<string, number> = {}) => {
    trace.end(span, { outcome, ...attrs });
    return outcome;
  };
  try {
    const ready = Promise.all([entry, whenLoadInteractive()]);
    if (await supersession(isStale, ready)) return finish('abandoned');
    const [target] = await ready;
    if (!target) return finish('no-entry');
    await idlePeriod();
    if (isStale()) return finish('abandoned');
    const encodeStart = performance.now();
    const blob = await encodeSceneSnapshotInSlices({ ...captured.snapshot, hostData: { ...captured.fit, shards: target.shards } }, sliceGap);
    const encodeMs = performance.now() - encodeStart;
    if (isStale()) return finish('abandoned');
    const stored = await putSceneSnapshot(target.cacheKey, target.write, blob, captured.key);
    return finish(stored ? 'written' : 'refused', { bytes: blob.size, encodeMs: Math.round(encodeMs) });
  } catch (err) {
    console.warn('[useIfcCache] Scene snapshot was not stored:', err);
    return finish('refused');
  }
}
