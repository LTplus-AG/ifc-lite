/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PointCloudAlignmentTransform } from './pointCloudAlignment';
import { rebasePointCloudDecodeOrigin, nativePointCloudOriginMatrix } from './pointCloudDecodeOrigin';

interface RegisteredAlignment {
  enabled: boolean;
  handle: { id: number };
  transform: PointCloudAlignmentTransform;
}

/**
 * Every currently-streamed point-cloud asset that has an alignment
 * transform available, keyed by its renderer handle id. Each scan keeps its own decode origin and alignment matrix so a
 * source opened later or removed independently cannot move another scan.
 */
const registry = new Map<number, RegisteredAlignment>();

export function registerPointCloudAlignment(
  handle: { id: number },
  transform: PointCloudAlignmentTransform,
  enabled = true,
): void {
  registry.set(handle.id, { handle, transform, enabled });
}

export function unregisterPointCloudAlignment(handleId: number): void {
  registry.delete(handleId);
}

export function hasRegisteredPointCloudAlignment(): boolean {
  return registry.size > 0;
}

/** Renderer surface this module needs — matches `@ifc-lite/renderer`'s
 *  `Renderer.setPointCloudTransform`. Typed narrowly here so this module
 *  doesn't need to import the whole `Renderer` class. */
export interface PointCloudTransformTarget {
  setPointCloudTransform(handle: { id: number }, matrix: Float32Array | Float64Array | null): void;
}

/**
 * Push either the aligned or unaligned matrix to every registered asset.
 * Called once at ingest time (default: aligned when a mapConversion is
 * available) and again whenever the UI toggle flips.
 */
export function applyPointCloudAlignmentToggle(
  renderer: PointCloudTransformTarget | null | undefined,
  enabled: boolean,
): void {
  if (!renderer) return;
  for (const entry of registry.values()) {
    entry.enabled = enabled;
    renderer.setPointCloudTransform(entry.handle, enabled ? entry.transform.alignedMatrix : entry.transform.unalignedMatrix);
  }
}

/** Update the decode base before the first chunk. A toggle changed while the
 * source opened stays authoritative; don't reuse the ingest-time boolean. */
export function retargetPointCloudDecodeOrigin(renderer: PointCloudTransformTarget, handle: { id: number }, origin: readonly [number, number, number]): void {
  const entry = registry.get(handle.id);
  if (!entry) { renderer.setPointCloudTransform(handle, nativePointCloudOriginMatrix(origin)); return; }
  entry.transform = rebasePointCloudDecodeOrigin(entry.transform, origin);
  renderer.setPointCloudTransform(handle, entry.enabled ? entry.transform.alignedMatrix : entry.transform.unalignedMatrix);
}
