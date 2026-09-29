/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How often a panel re-derives whole-model data from geometry WHILE that
 * geometry is still streaming in (#6411).
 *
 * A large load publishes geometry to the store every 500 ms
 * (`getRenderIntervalMs`), and every publish replaces `state.models`. Panels
 * that walk every mesh or every element on each publish (the hierarchy tree,
 * the object counts, the model statistics) saturated the main thread on a
 * 127K-element model: the geometry workers finished and then idled while the
 * main thread drained their batches. Streaming-time panel data is progress,
 * not a result, so it refreshes on this cadence and becomes exact the moment
 * streaming ends.
 */
export const STREAMING_PANEL_REFRESH_MS = 4000;

import type { FederatedModel } from '@/store/types';

/** Whether streaming-derived data last taken at `takenAt` is due for a refresh at `now` (ms, same clock). */
export function streamingRefreshDue(takenAt: number, now: number): boolean {
  return now - takenAt >= STREAMING_PANEL_REFRESH_MS;
}

/** A model whose geometry is still streaming in: every batch changes which ids have geometry. */
export function isModelStreaming(model: FederatedModel): boolean {
  return model.loadState === 'pending' || model.loadState === 'streaming-geometry';
}

/** Every model field except its geometry is the same: only geometry may be held. */
export function sameModelExceptGeometry(prev: FederatedModel, next: FederatedModel): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (key === 'geometryResult' || key === 'preAlignment') continue;
    if (prev[key as keyof FederatedModel] !== next[key as keyof FederatedModel]) return false;
  }
  return true;
}

/** The same models, in the same order, differing at most in their geometry. */
export function sameModelsExceptGeometry(
  prev: ReadonlyMap<string, FederatedModel>,
  next: ReadonlyMap<string, FederatedModel>,
): boolean {
  if (prev === next) return true;
  if (prev.size !== next.size) return false;
  const nextEntries = next.entries();
  for (const [id, model] of prev) {
    const step = nextEntries.next();
    if (step.done || step.value[0] !== id) return false;
    if (step.value[1] !== model && !sameModelExceptGeometry(model, step.value[1])) return false;
  }
  return true;
}
