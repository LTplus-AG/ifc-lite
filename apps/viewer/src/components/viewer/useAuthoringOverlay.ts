/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authoring ghost meshes (charter #6232, WP2): Space Sketch's draft rooms and
 * a modeling command's preview go straight into the renderer scene, NOT
 * through `geometryResult`, so per-frame updates cannot trip the streaming
 * reclassifier. One channel per producer: replacing one channel's meshes never
 * touches another's. Uploads run through `runGpuUpload` (#4885) with device
 * loss checked first.
 */

import { useCallback, useRef, type RefObject } from 'react';
import type { MeshData } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { runGpuUpload } from './gpu-upload-guard.js';

export type AuthoringOverlayChannel = 'spaceSketch' | 'command';

/**
 * Overlay ids that are still safe to remove from the scene.
 *
 * `removeMeshesForEntities` deletes EVERY mesh registered under an id, and the
 * ghost band is not reserved: `GHOST_ID_BASE` is 0x70000000 (~1.879e9) while
 * `FederationRegistry.MAX_SAFE_OFFSET` is 2e9, and unloading a model burns its
 * offset space permanently. A long federated session can therefore hand a real
 * model a global id inside the band that a live ghost already occupies, and
 * clearing the overlay would delete that model's geometry.
 *
 * `fromGlobalId` returns null for anything outside every registered range (it
 * bounds-checks against `maxExpressId`, not just the offset), so an id that now
 * resolves to a real model is dropped from the removal set. The residual failure
 * is a leaked ghost mesh, not deleted building geometry.
 */
function removableOverlayIds(ids: ReadonlySet<number>): Set<number> {
  const resolve = useViewerStore.getState().fromGlobalId;
  const safe = new Set<number>();
  for (const id of ids) if (!resolve(id)) safe.add(id);
  return safe;
}

export function useAuthoringOverlay(rendererRef: RefObject<Renderer | null>): {
  setAuthoringOverlayMeshes: (channel: AuthoringOverlayChannel, meshes: MeshData[]) => void;
  clearAuthoringOverlayMeshes: (channel: AuthoringOverlayChannel) => void;
} {
  const idsRef = useRef(new Map<AuthoringOverlayChannel, Set<number>>());

  const setAuthoringOverlayMeshes = useCallback((channel: AuthoringOverlayChannel, meshes: MeshData[]) => {
    const renderer = rendererRef.current;
    if (!renderer || renderer.isDeviceLost()) return;
    const scene = renderer.getScene(), device = renderer.getGPUDevice(), pipeline = renderer.getPipeline();
    if (!scene || !device || !pipeline) return;
    runGpuUpload(`setAuthoringOverlayMeshes:${channel}`, () => {
      const previous = idsRef.current.get(channel);
      if (previous && previous.size > 0) {
        scene.removeMeshesForEntities(removableOverlayIds(previous));
        idsRef.current.delete(channel);
      }
      if (meshes.length > 0) {
        // Rolled back on a GPU failure, or they would orphan as ghosts.
        const ids = new Set(meshes.map((m) => m.expressId));
        try { scene.appendToBatches(meshes, device, pipeline, false); idsRef.current.set(channel, ids); }
        catch (err) { scene.removeMeshesForEntities(removableOverlayIds(ids)); throw err; }
      }
      if (scene.hasPendingBatches()) scene.rebuildPendingBatches(device, pipeline);
    }, { isDeviceLost: () => renderer.isDeviceLost() });
    renderer.clearCaches();
    renderer.requestRender();
  }, [rendererRef]);

  const clearAuthoringOverlayMeshes = useCallback((channel: AuthoringOverlayChannel) => {
    const renderer = rendererRef.current;
    const scene = renderer?.getScene();
    const ids = idsRef.current.get(channel);
    if (!renderer || !scene || !ids || ids.size === 0) return;
    scene.removeMeshesForEntities(removableOverlayIds(ids));
    idsRef.current.delete(channel);
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    if (device && pipeline && scene.hasPendingBatches()) scene.rebuildPendingBatches(device, pipeline);
    renderer.clearCaches();
    renderer.requestRender();
  }, [rendererRef]);

  return { setAuthoringOverlayMeshes, clearAuthoringOverlayMeshes };
}
