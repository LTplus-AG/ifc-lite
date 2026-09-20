/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Streaming point-cloud handle lifecycle: `beginPointCloudStream` /
 * `appendPointCloudChunk` / `endPointCloudStream` / `removePointCloudAsset`,
 * plus the per-epoch guard that rejects a handle from a torn-down stream.
 *
 * Extracted from `Renderer` following the `scene-device-recovery.ts`
 * pattern — a `Host` interface for the fields these functions touch, so the
 * lifecycle stays testable without constructing a full `Renderer`. The
 * epoch bookkeeping itself (the `pointCloudStreamEpoch`/`pointCloudStreamEpochs`
 * fields, and the handle-id watermark that survives `teardown()`) stays on
 * `Renderer` — see `pointCloudNextHandleId` there and `PointCloudHandleIds`.
 */

import type { ModelBoundsBox } from '../model-bounds-tracker.js';
import { rendererDeviceLostError } from '../device-recovery.js';
import type { PointCloudChunkInput } from './point-cloud-node.js';
import type { PointCloudAssetHandle, PointCloudRenderer } from './point-cloud-renderer.js';

export interface PointCloudStreamHost {
  deviceLost: boolean;
  pointCloudRenderer: PointCloudRenderer | null;
  pointCloudStreamEpoch: number;
  readonly pointCloudStreamEpochs: Map<number, number>;
  readonly modelBoundsTracker: { expandForPointClouds(): void };
  readonly camera: { setSceneBounds(bounds: ModelBoundsBox | null): void };
  readonly modelBounds: ModelBoundsBox | null;
  requestRender(): void;
  refreshPlacementBounds(): void;
}

/**
 * Streaming entry: open an empty asset that will receive chunks via
 * `appendPointCloudChunk`. Call `endPointCloudStream` when no more
 * chunks will arrive (currently a no-op but kept for symmetry).
 */
export function beginPointCloudStream(
  host: PointCloudStreamHost,
  meta: { expressId: number; ifcType?: string; modelIndex?: number },
): PointCloudAssetHandle {
  if (host.deviceLost) throw rendererDeviceLostError();
  if (!host.pointCloudRenderer) {
    throw new Error('Renderer not initialized. Call init() first.');
  }
  const handle = host.pointCloudRenderer.beginAsset(meta);
  host.pointCloudStreamEpochs.set(handle.id, host.pointCloudStreamEpoch);
  return handle;
}

function currentPointCloudStreamRenderer(host: PointCloudStreamHost, handle: PointCloudAssetHandle): PointCloudRenderer {
  if (host.deviceLost || !host.pointCloudRenderer
    || host.pointCloudStreamEpochs.get(handle.id) !== host.pointCloudStreamEpoch) throw rendererDeviceLostError();
  return host.pointCloudRenderer;
}

export function appendPointCloudChunk(host: PointCloudStreamHost, handle: PointCloudAssetHandle, chunk: PointCloudChunkInput): void {
  currentPointCloudStreamRenderer(host, handle).appendChunk(handle, chunk);
  host.modelBoundsTracker.expandForPointClouds();
  host.camera.setSceneBounds(host.modelBounds);
  host.requestRender();
}

export function endPointCloudStream(host: PointCloudStreamHost, handle: PointCloudAssetHandle): void {
  currentPointCloudStreamRenderer(host, handle).endAsset(handle);
  host.requestRender();
}

export function removePointCloudAsset(host: PointCloudStreamHost, handle: PointCloudAssetHandle): void {
  if (!host.pointCloudStreamEpochs.delete(handle.id)) return;
  host.pointCloudRenderer?.removeAsset(handle);
  // Bounds may have shrunk — recompute from scratch so fit-to-view
  // and section-plane sliders see fresh extents.
  host.refreshPlacementBounds();
}
