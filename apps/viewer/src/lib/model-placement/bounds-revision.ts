/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import { uploadFlushBudgetMs } from '../upload-flush-budget';
import { activeLoadTrace } from '../perf/activeLoadTrace';

const listeners = new Set<() => void>();
let revision = 0;
export const getPlacementBoundsRevision = () => revision;
export function subscribePlacementBounds(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
/** Publish only after GPU upload and placement synchronization have finished.
 * Source-state renders can otherwise memoize the preceding GPU frame's bounds. */
export function publishPlacementBounds(): void {
  revision++;
  for (const listener of listeners) listener();
}

/** Queued streaming geometry reaches the scene later than React's upload effect.
 * `interacting` keeps frames short while the user navigates (see `uploadFlushBudgetMs`).
 * Each slice that uploads is a `scene.flushPending` span on the streaming load (#6979). */
export function flushPlacementGeometry(scene: ReturnType<Renderer['getScene']>, device: GPUDevice,
  pipeline: NonNullable<ReturnType<Renderer['getPipeline']>>, interacting = false): boolean {
  const flushed = scene.flushPending(device, pipeline, uploadFlushBudgetMs(interacting), activeLoadTrace());
  if (flushed) publishPlacementBounds();
  return flushed;
}
