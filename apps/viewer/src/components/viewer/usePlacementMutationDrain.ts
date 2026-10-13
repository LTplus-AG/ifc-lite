/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { runGpuUpload } from './gpu-upload-guard.js';

type PlacementMutation =
  | { kind: 'translations'; pending: Map<number, [number, number, number]> | null }
  | { kind: 'rotations'; pending: Map<number, { angle: number; pivot: [number, number, number] }> | null };

type Params = PlacementMutation & {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  gpuRecoveryEpoch: number;
  clearPending: () => void;
};

/** Consume the CPU delta once; a failed GPU stage retries only its dirty batches. */
export function usePlacementMutationDrain(params: Params): void {
  const { rendererRef, isInitialized, gpuRecoveryEpoch, kind, pending, clearPending } = params;
  const needsGpuRetry = useRef(false);

  useEffect(() => {
    if (!isInitialized || (pending === null && !needsGpuRetry.current)) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    if (!device || !pipeline) return;
    const scene = renderer.getScene();

    if (pending !== null) {
      if (pending.size > 0) {
        if (kind === 'translations') scene.translateMeshesForEntities(pending);
        else scene.rotateMeshesForEntities(pending);
        needsGpuRetry.current = true;
      }
      // New edits must merge only unapplied deltas, even if this upload fails.
      clearPending();
    }
    if (!needsGpuRetry.current) return;

    if (scene.hasPendingBatches()) {
      const rebuilt = runGpuUpload(`rebuildPendingBatches:${kind}`, () => {
        scene.rebuildPendingBatches(device, pipeline);
        return true;
      }) ?? false;
      if (!rebuilt) return;
    }
    // Retire pre-move streaming fragments so they cannot draw a ghost pose.
    if (scene.hasStreamingFragments() && !scene.isEphemeralStreaming()) {
      const finalized = runGpuUpload(`finalizeStreaming:${kind}`, () => {
        scene.finalizeStreaming(device, pipeline);
        return true;
      }) ?? false;
      if (!finalized) return;
    }
    needsGpuRetry.current = false;
    renderer.requestRender();
  }, [pending, isInitialized, gpuRecoveryEpoch, kind, clearPending]);
}
