/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sync IFCx-derived point cloud assets to the renderer.
 *
 * Mirrors `useGeometryStreaming` for point clouds: on every change of the
 * `pointClouds` array we replace the renderer's asset list and request a
 * fresh frame. Phase 0 has no streaming for points — assets are uploaded
 * in their entirety up front.
 */

import { useEffect, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { PointCloudAsset } from '@ifc-lite/geometry';

export interface UsePointCloudSyncParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  pointClouds: ReadonlyArray<PointCloudAsset> | null | undefined;
}

export function usePointCloudSync(params: UsePointCloudSyncParams): void {
  const { rendererRef, isInitialized, pointClouds } = params;

  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const assets = pointClouds ?? [];
    renderer.setPointClouds(assets);
    renderer.requestRender();
  }, [pointClouds, isInitialized, rendererRef]);
}

export default usePointCloudSync;
