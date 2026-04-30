/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sync IFCx-derived point cloud assets to the renderer.
 *
 * On every change of the `pointClouds` array we replace the renderer's
 * asset list and request a fresh frame. When the active scene has no
 * triangle meshes (the buildingSMART point-cloud-only samples), we
 * additionally trigger a one-shot camera fit — the geometry streaming
 * hook bails out early in that case and would otherwise leave points
 * stranded outside the camera frustum.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { PointColorMode, Renderer } from '@ifc-lite/renderer';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';

export interface UsePointCloudSyncParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  pointClouds: ReadonlyArray<PointCloudAsset> | null | undefined;
  /** True when the scene has triangle meshes — the geometry streaming
   *  hook owns fit-to-view in that case and we shouldn't fight it. */
  hasMeshes: boolean;
}

export function usePointCloudSync(params: UsePointCloudSyncParams): void {
  const { rendererRef, isInitialized, pointClouds, hasMeshes } = params;
  const colorMode = useViewerStore((s) => s.pointCloudColorMode) as PointColorMode;
  const fixedColor = useViewerStore((s) => s.pointCloudFixedColor);
  const setAssetCount = useViewerStore((s) => s.setPointCloudAssetCount);
  const fittedRef = useRef(false);

  // Reset the one-shot fit flag whenever the asset list identity changes.
  useEffect(() => {
    fittedRef.current = false;
  }, [pointClouds]);

  // Replace IFCx-owned assets when the merged list changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;

    const assets = pointClouds ?? [];
    renderer.setPointClouds(assets);
    const count = renderer.getPointCloudAssetCount();
    setAssetCount(count);

    // Camera fit for points-only scenes — useGeometryStreaming skips its
    // own fit branch when meshes is empty, so points stay off-screen
    // unless we step in. Run once per fresh asset list.
    if (count > 0 && !hasMeshes && !fittedRef.current) {
      const bounds = renderer.getModelBounds();
      if (bounds && Number.isFinite(bounds.min.x) && Number.isFinite(bounds.max.x)) {
        renderer.getCamera().fitToBounds(bounds.min, bounds.max);
        fittedRef.current = true;
      }
    }

    renderer.requestRender();
  }, [pointClouds, isInitialized, rendererRef, setAssetCount, hasMeshes]);

  // Push color-mode preferences to the renderer whenever the user changes them
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || !isInitialized) return;
    renderer.setPointCloudOptions({ colorMode, fixedColor });
    renderer.requestRender();
  }, [colorMode, fixedColor, isInitialized, rendererRef]);
}

export default usePointCloudSync;
