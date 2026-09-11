/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';

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

/** Queued streaming geometry reaches the scene later than React's upload effect. */
export function flushPlacementGeometry(scene: ReturnType<Renderer['getScene']>, device: GPUDevice,
  pipeline: NonNullable<ReturnType<Renderer['getPipeline']>>): boolean {
  const flushed = scene.flushPending(device, pipeline);
  if (flushed) publishPlacementBounds();
  return flushed;
}
