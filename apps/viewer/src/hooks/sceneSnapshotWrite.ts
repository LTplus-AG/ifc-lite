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

import { encodeSceneSnapshotInSlices, reorderSnapshotPieces, type SceneSnapshot } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import type { LoadTrace } from '@ifc-lite/load-trace';
import { afterModelSettled } from '../lib/perf/afterLoad.js';
import { idlePeriod } from '../lib/perf/afterLoadIdle.js';
import { useViewerStore } from '../store/index.js';
import { putSceneSnapshot, type SceneSnapshotWrite } from '../services/cacheService.js';
import type { SnapshotCameraFit } from '../components/viewer/sceneSnapshotOwnership.js';

/** A finished scene as the finalize swap left it, with what a reopen needs to draw it. */
export interface CapturedScene {
  snapshot: SceneSnapshot;
  /** The mesh each piece was queued from, by ordinal (the capture's own record). */
  sources: readonly MeshData[];
  fit: SnapshotCameraFit;
  /** `sceneSnapshotKey` at the swap: the type visibility the batches were built under. */
  key: string;
  /**
   * The scene's batch policy when the write runs. A capture taken before quantized
   * admission settled holds f32 batches that a reopen would refuse, so it is not stored.
   */
  policyNow: () => string;
  /** The owning load failed for good: the capture is released instead of waiting for an entry. */
  loadFailed: () => boolean;
  /**
   * Why the scene no longer matches the capture, checked right before the store
   * (the entry is serialized from the live meshes after the swap): an edit since
   * the swap (`scene-changed`), or level display moving pieces (`level-offsets`).
   */
  changedSince: () => string | null;
}

/** The cache entry write a snapshot belongs to. */
export interface SnapshotEntry {
  cacheKey: string;
  write: SceneSnapshotWrite;
  /** Where the entry keeps its instanced shards, which a snapshot reopen reads directly. */
  shards: { offset: number; size: number } | null;
  /**
   * The order the entry stores the meshes in (spatial chunks), which is the order
   * a reopen hydrates them in. A cold load queued them in arrival order, so its
   * ordinals move to this order; a hit already queued them in it (absent).
   */
  meshOrder?: readonly MeshData[];
}

export type SnapshotWriteOutcome = 'written' | 'refused' | 'abandoned' | 'no-entry' | 'policy-changed' | 'order-mismatch' | 'scene-changed' | 'failed';

const STALE_POLL_MS = 250;
const SLICE_IDLE_TIMEOUT_MS = 500;
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

/** One idle slice before each piece of work, unless the tab is hidden. */
async function sliceGap(): Promise<void> {
  if (pageHidden()) return yieldToHost();
  return idlePeriod(SLICE_IDLE_TIMEOUT_MS);
}

function abandonReason(isStale: () => boolean, captured: CapturedScene): string {
  return isStale() ? 'superseded' : captured.loadFailed() ? 'load-failed' : 'entry-timeout';
}

/**
 * Encode and store `captured` beside `entry` once its model's load has settled
 * and the page is idle: the `snapshot-write` job of the shared post-load
 * schedule (lib/perf/afterLoadIdle.ts), which runs before every other post-load
 * job. Ends the trace span `span` (begun by the caller at the swap).
 */
export async function writeCapturedScene(
  captured: CapturedScene,
  entry: Promise<SnapshotEntry | null>,
  isStale: () => boolean,
  trace: LoadTrace,
  span: number,
  modelId: string | null = null,
): Promise<SnapshotWriteOutcome> {
  let ended: SnapshotWriteOutcome | null = null;
  const finish = (outcome: SnapshotWriteOutcome, attrs: Record<string, number | string> = {}) => {
    if (ended) return ended; // one outcome per span, also when an abandoned job's encode returns later
    ended = outcome;
    trace.end(span, { outcome, ...attrs });
    return outcome;
  };
  const gone = () => isStale() || captured.loadFailed();
  const abandoned = () => finish('abandoned', { reason: abandonReason(isStale, captured) });
  try {
    if (await supersession(gone, entry)) return abandoned();
    const target = await entry;
    if (!target) return finish('no-entry');
    // Bound to the model's current store too: a reload under the same id drops it.
    const modelStore = modelId === null ? null : useViewerStore.getState().models.get(modelId)?.ifcDataStore ?? null;
    const job = afterModelSettled({ job: 'snapshot-write', modelId, store: modelStore }, (signal) => store(target, signal).catch((err: unknown) => {
      console.warn('[useIfcCache] Scene snapshot was not stored:', err);
      return finish('failed');
    }));
    if (await supersession(gone, job.result.then(() => {}))) { job.cancel(); return abandoned(); }
    return (await job.result) ?? finish('abandoned', { reason: 'model-removed' });
  } catch (err) {
    console.warn('[useIfcCache] Scene snapshot was not stored:', err);
    return finish('failed');
  }

  async function store(target: SnapshotEntry, signal: AbortSignal): Promise<SnapshotWriteOutcome> {
    if (signal.aborted || gone()) return abandoned();
    if (captured.policyNow() !== captured.snapshot.policy) return finish('policy-changed');
    const encodeStart = performance.now();
    // Hydration matches pieces by ordinal; one it would refuse is not worth storing.
    const snapshot = target.meshOrder ? reorderSnapshotPieces(captured.snapshot, captured.sources, target.meshOrder) : captured.snapshot;
    if (!snapshot) return finish('order-mismatch');
    const blob = await encodeSceneSnapshotInSlices({ ...snapshot, hostData: { ...captured.fit, shards: target.shards } }, sliceGap);
    const encodeMs = performance.now() - encodeStart;
    if (signal.aborted || gone()) return abandoned();
    const changed = captured.changedSince();
    if (changed) return finish('scene-changed', { reason: changed });
    // `refused`: the entry was replaced or purged, or quota is short (putSceneSnapshot's own guards).
    const stored = await putSceneSnapshot(target.cacheKey, target.write, blob, captured.key);
    return finish(stored ? 'written' : 'refused', { bytes: blob.size, encodeMs: Math.round(encodeMs) });
  }
}
