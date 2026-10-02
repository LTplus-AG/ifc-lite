/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The renderer side of authoring edits that swap or drop existing meshes:
 * `pendingMeshRemovals` (split, delete) and `pendingMeshEdits` (re-meshed
 * elements, `replaceEntityMeshes`, #6232 WP1).
 *
 * MUST be called BEFORE `useGeometryStreaming`'s main geometry effect (React
 * runs a component's effects in declaration order). That effect classifies a
 * change by array LENGTH and appends `geometry.slice(lastLength)` as new, so
 * a replacement, which removes an entity's meshes and appends its new ones at
 * the owning model's tail, reads to it as either a shrink (a full reshape of
 * the scene) or growth whose tail is the wrong meshes. This drain applies the
 * swap to the scene itself and then advances the main effect's length/array
 * refs past it, so the main effect sees no change.
 *
 * It only advances them when the replacement is the ONLY geometry change
 * since the main effect last ran: the tick the previous render committed is
 * the one just before the replacement, and the store is still on the one it
 * ended on. Otherwise (a batch appended in the same render, a later change)
 * it forces the main effect's keep-camera rebuild, which is correct for any
 * mix of changes.
 *
 * Removals run first, then edits: an id both removed and re-meshed in one
 * render must end up with its new meshes, which removal-after-append (the
 * order before this hook existed) would wipe.
 */

import { useEffect, useRef, type MutableRefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { watchModelUnloads } from '@/lib/remesh/remesh-service';
import { runGpuUpload } from './gpu-upload-guard';
import { geometryMeshKey } from './geometry-mesh-key';

export interface MeshEditDrainParams {
  rendererRef: MutableRefObject<Renderer | null>;
  isInitialized: boolean;
  isStreaming: boolean;
  geometry: MeshData[] | null;
  pendingMeshRemovals: Set<number> | null;
  clearPendingMeshRemovals: () => void;
  pruneGeometryMeshes: (ids: Set<number>) => void;
  /** The main geometry effect's bookkeeping, advanced past a drained edit. */
  lastGeometryLengthRef: MutableRefObject<number>;
  lastGeometryRef: MutableRefObject<MeshData[] | null>;
  processedMeshIdsRef: MutableRefObject<Set<string>>;
}

export function useMeshEditDrain(params: MeshEditDrainParams): void {
  const {
    rendererRef, isInitialized, isStreaming, geometry,
    pendingMeshRemovals, clearPendingMeshRemovals, pruneGeometryMeshes,
    lastGeometryLengthRef, lastGeometryRef, processedMeshIdsRef,
  } = params;
  const pendingMeshEdits = useViewerStore((s) => s.pendingMeshEdits);
  const clearPendingMeshEdits = useViewerStore((s) => s.clearPendingMeshEdits);
  const geometryUpdateTick = useViewerStore((s) => s.geometryUpdateTick);
  /** The tick of the last committed render; see the effect at the bottom. */
  const renderedTickRef = useRef(geometryUpdateTick);

  // The re-mesh worker goes when a model does (see `watchModelUnloads`).
  useEffect(() => watchModelUnloads(useViewerStore.subscribe), []);

  // ─── Mesh removals (split / delete) ───────────────────────────────────
  // Authoring actions push globalIds into pendingMeshRemovals; drain
  // here so the renderer actually drops them rather than leaving the
  // mesh hidden via the visibility set. The bucket rebuild rides
  // along on the existing rebuildPendingBatches path the streaming
  // queue already exercises every frame.
  useEffect(() => {
    if (pendingMeshRemovals === null || !isInitialized) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    const scene = renderer.getScene();
    if (!device || !pipeline) return;

    if (pendingMeshRemovals.size > 0) {
      scene.removeMeshesForEntities(pendingMeshRemovals);
      // Keep the store's geometryResult.meshes (and totalTriangles /
      // totalVertices) in sync with what the scene just dropped — see
      // `pruneGeometryMeshes` in dataSlice.ts. Idempotent: a retry after a
      // failed rebuild below re-prunes the same ids for zero net effect.
      pruneGeometryMeshes(pendingMeshRemovals);
      if (scene.hasPendingBatches()) {
        const rebuilt = runGpuUpload(
          'rebuildPendingBatches:removals',
          () => { scene.rebuildPendingBatches(device, pipeline); return true; },
        ) ?? false;
        // Leave the pending map intact on failure so the next mutation retries
        // this rebuild instead of dropping it.
        if (!rebuilt) return;
      }
      renderer.requestRender();
    }
    clearPendingMeshRemovals();
  }, [pendingMeshRemovals, isInitialized, clearPendingMeshRemovals, pruneGeometryMeshes]);

  // ─── Re-meshed elements (replaceEntityMeshes) ─────────────────────────
  useEffect(() => {
    // A streamed batch is appended by index; wait until the stream settles.
    if (pendingMeshEdits === null || !isInitialized || !geometry || isStreaming) return;
    const renderer = rendererRef.current;
    if (!renderer) return;
    const device = renderer.getGPUDevice();
    const pipeline = renderer.getPipeline();
    if (!device || !pipeline) return;
    const scene = renderer.getScene();
    const { ids, since, tick } = pendingMeshEdits;

    // Removing is idempotent (a retry after a failed upload finds nothing
    // left to remove); it also retires an instanced occurrence of the id,
    // whose re-mesh arrives as flat geometry.
    scene.removeMeshesForEntities(ids);
    const fresh: MeshData[] = [];
    const freshKeys: string[] = [];
    geometry.forEach((mesh, index) => {
      if (!ids.has(mesh.expressId)) return;
      fresh.push(mesh);
      freshKeys.push(geometryMeshKey(mesh, index));
    });
    const uploaded = runGpuUpload('appendToBatches:mesh-edits', () => {
      if (fresh.length > 0) scene.appendToBatches(fresh, device, pipeline, false);
      else if (scene.hasPendingBatches()) scene.rebuildPendingBatches(device, pipeline);
      return true;
    }) ?? false;
    // Leave the edit queued on failure so the next render retries it.
    if (!uploaded) return;

    if (renderedTickRef.current === since && useViewerStore.getState().geometryUpdateTick === tick) {
      // Camera fitting can still scan the same-length source after this drain.
      // Claim only the parts whose upload succeeded, using the same source-slot
      // identity as the main effect; neither item IDs nor coordinates dedupe parts.
      for (const key of freshKeys) processedMeshIdsRef.current.add(key);
      lastGeometryLengthRef.current = geometry.length;
      lastGeometryRef.current = geometry;
    } else {
      // Something else changed the geometry since the main effect last ran: fall back to
      // the main effect's rebuild-keeping-camera (its shrink branch).
      processedMeshIdsRef.current.clear();
      lastGeometryLengthRef.current = geometry.length + 1;
    }
    renderer.clearCaches();
    renderer.requestRender();
    clearPendingMeshEdits();
  }, [pendingMeshEdits, geometry, isInitialized, isStreaming, clearPendingMeshEdits]);

  // Declared AFTER the edit drain, so that drain still reads the tick of the
  // previous committed render, the one the main effect last consumed.
  useEffect(() => { renderedTickRef.current = geometryUpdateTick; }, [geometryUpdateTick]);
}
