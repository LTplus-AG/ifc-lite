/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 3D snapshots for the report (#3944): for each chart, frame the elements of
 * its largest bucket with everything else ghosted, and read the canvas.
 *
 * The shared capture gate drives an owned frame, as clash BCF export does, so
 * the store's channels — and the charts panel's ownership claim on them —
 * are never touched; camera restoration belongs to each owned capture, so a
 * capture that throws cannot strand the view.
 */
import { getGlobalRenderer } from '@/hooks/useBCF';
import { captureEntityViewportFrame } from '@/lib/export/entity-viewport-capture';
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
 * renderer (headless, WebGPU unavailable). Each capture restores its camera;
 * the returned `restore` requests a normal frame after the last capture.
 */
export function createSnapshotCapture(): { capture: SnapshotCapture; restore: () => void } | null {
  const renderer = getGlobalRenderer();
  if (!renderer) return null;
  const scene = renderer.getScene();
  const meshes = allMeshes();

  const restore = (): void => { renderer.requestRender(); };

  const capture: SnapshotCapture = async (ids) => {
    if (ids.length === 0) return undefined;
    const bounds = unionEntityBounds(meshes, [...ids], (id) => scene.getInstancedEntityBounds(id));
    const dataUrl = await captureEntityViewportFrame(renderer, {
      ids: new Set(ids), mode: 'ghost', bounds: bounds ?? undefined, clearColor: SNAPSHOT_CLEAR_COLOR,
    });
    return dataUrl ? dataUrlToBytes(dataUrl) : undefined;
  };

  return { capture, restore };
}
