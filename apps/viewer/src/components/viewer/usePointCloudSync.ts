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
import type { PointColorMode, Renderer } from '@ifc-lite/renderer';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';

export interface UsePointCloudSyncParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  pointClouds: ReadonlyArray<PointCloudAsset> | null | undefined;
}

export function usePointCloudSync(params: UsePointCloudSyncParams): void {
  const { rendererRef, isInitialized, pointClouds } = params;
  const colorMode = useViewerStore((s) => s.pointCloudColorMode) as PointColorMode;
  const fixedColor = useViewerStore((s) => s.pointCloudFixedColor);

  const setAssetCount = useViewerStore((s) => s.setPointCloudAssetCount);

  // Replace IFCx-owned assets when the merged list changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const assets = pointClouds ?? [];
    renderer.setPointClouds(assets);
    setAssetCount(renderer.getPointCloudAssetCount());
    renderer.requestRender();
  }, [pointClouds, isInitialized, rendererRef, setAssetCount]);

  // Push color-mode preferences to the renderer whenever the user changes them
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    renderer.setPointCloudOptions({ colorMode, fixedColor });
    renderer.requestRender();
  }, [colorMode, fixedColor, isInitialized, rendererRef]);
}

export default usePointCloudSync;
