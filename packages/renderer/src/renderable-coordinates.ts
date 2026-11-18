/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Coordinates accepted by the finite float32 GPU translation boundary. */
export function renderableCoordinates(values: readonly number[]): boolean {
  return values.length === 3 && values.every((v) => Number.isFinite(v) && Number.isFinite(Math.fround(v)));
}

/** Whether an inline cloud renders: it has points (a streamed scan's
 * descriptor has none) and its optional origin can cross the GPU boundary.
 * Dependency-free, so the core entry's pick key uses it without loading a
 * point-cloud module. Pick identity and the viewer's class histogram use it;
 * uploads apply its two halves separately (setAssets drops clouds with no points, bulk uploads skip
 * a bad origin with a warning) (#10094). */
export function isRenderablePointCloud(asset: { origin?: readonly number[] | null; chunk: { pointCount: number } }): boolean {
  return asset.chunk.pointCount > 0 && (asset.origin == null || renderableCoordinates(asset.origin));
}
