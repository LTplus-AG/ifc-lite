/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tear down streamed point cloud GPU resources when a model is removed.
 *
 * Streamed assets (LAS/LAZ) live in a separate ownership bucket on the
 * renderer (see `PointCloudRenderer`'s `'streamed'` owner tag), so they
 * survive `setPointClouds` calls. That isolation cuts both ways: nothing
 * else clears them, so when a model is removed we have to do it here or
 * the GPU buffers leak for the rest of the session.
 *
 * The hook tracks the previous set of `(modelId → handleId)` pairs and,
 * on every store change, frees the handles for models that disappeared.
 * Pure cleanup — no state mutation.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';

export interface UsePointCloudLifecycleParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
}

export function usePointCloudLifecycle(params: UsePointCloudLifecycleParams): void {
  const { rendererRef, isInitialized } = params;
  const models = useViewerStore((s) => s.models);
  const decCount = useViewerStore((s) => s.incrementPointCloudAssetCount);
  const previousRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    if (!isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;

    const current = new Map<string, number>();
    for (const [modelId, model] of models) {
      if (typeof model.pointCloudHandleId === 'number') {
        current.set(modelId, model.pointCloudHandleId);
      }
    }

    // Dispose handles whose model disappeared OR whose model still
    // exists but was rebound to a new handle (e.g. the user reloaded
    // the same file and got a fresh streaming session). Without the
    // rebind branch the old GPU buffers stay allocated for the rest
    // of the session.
    for (const [modelId, handleId] of previousRef.current) {
      const nextHandle = current.get(modelId);
      if (nextHandle !== handleId) {
        renderer.removePointCloudAsset({ id: handleId });
        decCount(-1);
      }
    }

    previousRef.current = current;
    renderer.requestRender();
  }, [models, isInitialized, rendererRef, decCount]);
}

export default usePointCloudLifecycle;
