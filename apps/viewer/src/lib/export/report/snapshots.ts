/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D snapshots for the report (#3944): for each chart, frame the elements of
 * its largest bucket with everything else ghosted, and read the canvas.
 *
 * The renderer is driven directly, the way the clash BCF export does it, so
 * the store's channels — and the charts panel's ownership claim on them —
 * are never touched; the camera is put back where it was in `finally`, so a
 * capture that throws cannot strand the view.
 */
import { getGlobalRenderer } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { dataUrlToBytes } from '@/lib/export/download';
import { unionEntityBounds } from '@/utils/viewportUtils';
import type { MeshData } from '@ifc-lite/geometry';

/** Dark neutral ground, the clash export's colour, so ghosted elements read against it. */
const SNAPSHOT_CLEAR_COLOR: [number, number, number, number] = [0.04, 0.05, 0.1, 1];

export type SnapshotCapture = (ids: readonly number[]) => Promise<Uint8Array | undefined>;

/** Every loaded model's meshes; their ids are already in the renderer's global space. */
function allMeshes(): MeshData[] {
  const state = useViewerStore.getState();
  const meshes: MeshData[] = [];
  for (const model of state.models.values()) if (model.geometryResult?.meshes) meshes.push(...model.geometryResult.meshes);
  if (meshes.length === 0 && state.geometryResult?.meshes) meshes.push(...state.geometryResult.meshes);
  return meshes;
}

/**
 * A capture function bound to the live renderer, or `null` when there is no
 * renderer (headless, WebGPU unavailable). The returned `restore` puts the
 * camera and the frame back; call it once after the last capture.
 */
export function createSnapshotCapture(): { capture: SnapshotCapture; restore: () => void } | null {
  const renderer = getGlobalRenderer();
  if (!renderer) return null;
  const state = useViewerStore.getState();
  const camera = renderer.getCamera();
  const scene = renderer.getScene();
  const viewpoint = state.cameraCallbacks?.getViewpoint?.() ?? null;
  const meshes = allMeshes();

  const restore = (): void => {
    if (viewpoint) state.cameraCallbacks?.applyViewpoint?.(viewpoint, false);
    const s = useViewerStore.getState();
    renderer.render({
      hiddenIds: s.hiddenEntities,
      isolatedIds: s.isolatedEntities,
      ghostExceptIds: s.ghostExceptEntities,
      selectedId: s.selectedEntityId,
      selectedIds: s.selectedEntityIds,
    });
  };

  const capture: SnapshotCapture = async (ids) => {
    if (ids.length === 0) return undefined;
    const bounds = unionEntityBounds(meshes, [...ids], (id) => scene.getInstancedEntityBounds(id));
    // Duration 1, not 0: the camera only steps an animation with a positive
    // duration, so a 0 ms frame never completes and the export hangs on it.
    if (bounds) await camera.frameBounds(bounds.min, bounds.max, 1);
    // restoreEvictedForCapture: a ghosted frame may reveal batches evicted
    // under the GPU residency budget — restore synchronously so the snapshot
    // is complete.
    renderer.render({ ghostExceptIds: new Set(ids), isolatedIds: null, selectedId: null, clearColor: SNAPSHOT_CLEAR_COLOR, restoreEvictedForCapture: true });
    const device = renderer.getGPUDevice();
    if (device) await device.queue.onSubmittedWorkDone();
    // FRAME-WAIT-ALLOW(#2385): the frame must actually be presented before
    // the canvas is read; a timeout would capture a stale frame.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const dataUrl = await renderer.captureScreenshot();
    return dataUrl ? dataUrlToBytes(dataUrl) : undefined;
  };

  return { capture, restore };
}
