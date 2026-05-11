/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * UI bridge for conflict surfacing (spec §9.7).
 *
 * The detector reports raw events at every concurrent write. The viewer
 * (or any UI) needs:
 *   - a stable list of currently-active conflicts grouped by entity path
 *   - notifications when a conflict appears, ages out, or resolves
 *   - a clean "resolve mine" / "accept theirs" handle that emits a
 *     follow-up edit on resolution
 *
 * This module sits between the detector and the UI. It does NOT touch
 * the CRDT — resolution is a normal write that the caller dispatches
 * inside its own transaction.
 */

import type { ConflictDetector, ConflictEvent } from './detector.js';

export type ConflictBucketKey = string;

export interface ConflictBucket {
  key: ConflictBucketKey;
  /** Entity / relationship / geometry path involved. */
  path: string;
  /** Optional sub-path (e.g. attribute name). */
  field?: string;
  kind: ConflictEvent['kind'];
  /** All clientIDs that wrote in the conflict window. */
  contributors: Set<number>;
  /** Wall-clock ms of the first event in the bucket. */
  firstSeenAt: number;
  /** Wall-clock ms of the most-recent event. */
  lastSeenAt: number;
  /** Number of detector events folded into this bucket. */
  count: number;
}

export type BridgeEventType = 'open' | 'update' | 'close';

export interface BridgeEvent {
  type: BridgeEventType;
  bucket: ConflictBucket;
}

export type BridgeListener = (event: BridgeEvent) => void;

export interface ConflictUIBridgeOptions {
  /** A bucket closes after this many ms with no new events (default 4_000). */
  closeAfterMs?: number;
}

export interface ResolutionContext {
  bucket: ConflictBucket;
}

export type ResolutionAction = (ctx: ResolutionContext) => void | Promise<void>;

export interface ConflictUIBridge {
  /** All currently-open buckets. */
  active(): ConflictBucket[];
  /** Subscribe to bucket lifecycle (open / update / close). */
  on(listener: BridgeListener): () => void;
  /**
   * Mark a bucket resolved (close immediately). Useful when the UI
   * dispatches a "keep mine" edit and wants the badge to disappear.
   */
  resolve(key: ConflictBucketKey): boolean;
  /**
   * Run the registered "keep mine" callback (if any) and close the
   * bucket. Apps register the callback per kind via `onKeepMine`. The
   * callback is responsible for emitting the follow-up CRDT edit that
   * re-asserts the local user's value.
   */
  keepMine(key: ConflictBucketKey): Promise<boolean>;
  /** Same shape as `keepMine`, but for "accept theirs". */
  acceptTheirs(key: ConflictBucketKey): Promise<boolean>;
  /** Register a "keep mine" handler for a given conflict kind. */
  onKeepMine(kind: ConflictBucket['kind'], action: ResolutionAction): () => void;
  /** Register an "accept theirs" handler for a given conflict kind. */
  onAcceptTheirs(kind: ConflictBucket['kind'], action: ResolutionAction): () => void;
  destroy(): void;
}

/**
 * Build a UI bridge subscribed to `detector`.
 *
 * Each `(kind, path, field)` triple maps to one bucket. A new event
 * folded into an existing bucket emits `update`; a new triple emits
 * `open`; an idle timeout or explicit `resolve()` emits `close`.
 */
export function createConflictUIBridge(
  detector: ConflictDetector,
  opts: ConflictUIBridgeOptions = {},
): ConflictUIBridge {
  const closeAfterMs = opts.closeAfterMs ?? 4_000;
  const buckets = new Map<ConflictBucketKey, ConflictBucket>();
  const listeners = new Set<BridgeListener>();
  const keepMineHandlers = new Map<ConflictBucket['kind'], Set<ResolutionAction>>();
  const acceptTheirsHandlers = new Map<ConflictBucket['kind'], Set<ResolutionAction>>();
  let timer: ReturnType<typeof setInterval> | null = setInterval(sweep, 1_000);

  function bucketKey(e: ConflictEvent): ConflictBucketKey {
    return `${e.kind}|${e.path}|${e.field ?? ''}`;
  }

  function emit(type: BridgeEventType, bucket: ConflictBucket) {
    listeners.forEach((l) => l({ type, bucket }));
  }

  function sweep() {
    const now = Date.now();
    for (const bucket of Array.from(buckets.values())) {
      if (now - bucket.lastSeenAt > closeAfterMs) {
        buckets.delete(bucket.key);
        emit('close', bucket);
      }
    }
  }

  const unsubscribe = detector.onConflict((event) => {
    const key = bucketKey(event);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        path: event.path,
        field: event.field,
        kind: event.kind,
        contributors: new Set(event.contributors),
        firstSeenAt: event.detectedAt,
        lastSeenAt: event.detectedAt,
        count: 1,
      };
      buckets.set(key, bucket);
      emit('open', bucket);
      return;
    }
    bucket.lastSeenAt = event.detectedAt;
    bucket.count += 1;
    let added = false;
    for (const c of event.contributors) {
      if (!bucket.contributors.has(c)) {
        bucket.contributors.add(c);
        added = true;
      }
    }
    if (added) emit('update', bucket);
  });

  async function runActions(
    table: Map<ConflictBucket['kind'], Set<ResolutionAction>>,
    bucket: ConflictBucket,
  ): Promise<void> {
    const set = table.get(bucket.kind);
    if (!set || set.size === 0) return;
    for (const action of set) await action({ bucket });
  }

  return {
    active: () => Array.from(buckets.values()),
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resolve(key) {
      const bucket = buckets.get(key);
      if (!bucket) return false;
      buckets.delete(key);
      emit('close', bucket);
      return true;
    },
    async keepMine(key) {
      const bucket = buckets.get(key);
      if (!bucket) return false;
      await runActions(keepMineHandlers, bucket);
      buckets.delete(key);
      emit('close', bucket);
      return true;
    },
    async acceptTheirs(key) {
      const bucket = buckets.get(key);
      if (!bucket) return false;
      await runActions(acceptTheirsHandlers, bucket);
      buckets.delete(key);
      emit('close', bucket);
      return true;
    },
    onKeepMine(kind, action) {
      const set = keepMineHandlers.get(kind) ?? new Set<ResolutionAction>();
      set.add(action);
      keepMineHandlers.set(kind, set);
      return () => set.delete(action);
    },
    onAcceptTheirs(kind, action) {
      const set = acceptTheirsHandlers.get(kind) ?? new Set<ResolutionAction>();
      set.add(action);
      acceptTheirsHandlers.set(kind, set);
      return () => set.delete(action);
    },
    destroy() {
      unsubscribe();
      if (timer) clearInterval(timer);
      timer = null;
      buckets.clear();
      listeners.clear();
      keepMineHandlers.clear();
      acceptTheirsHandlers.clear();
    },
  };
}
