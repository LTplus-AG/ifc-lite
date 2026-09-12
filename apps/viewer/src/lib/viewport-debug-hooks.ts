/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import type { MeshData } from '@ifc-lite/geometry';

/** One resident part of an owner as plain data: no buffers, no live objects. */
export interface ScenePartSnapshot {
  geometryItemId: number | undefined;
  triangles: number;
  vertices: number;
  textured: boolean;
  color: [number, number, number, number];
}
/** What the scene currently renders for one federation-resolved id. */
export interface SceneOwnerSnapshot {
  /** Flat (resident) parts, `null` when the owner has none. */
  flat: ScenePartSnapshot[] | null;
  /** Whether the owner is currently drawn as a GPU instance. */
  instance: boolean;
  /** Placed corner positions of the flat parts, or of the instance, for exact comparisons across steps. */
  corners: number[];
  /** Client-space centre of the owner's bounds, where a viewport click would land; `null` off screen. */
  screen: { x: number; y: number } | null;
}

function snapshot(part: MeshData): ScenePartSnapshot {
  return { geometryItemId: part.geometryItemId, triangles: part.indices.length / 3, vertices: part.positions.length / 3,
    textured: !!(part.uvs && (part.texture || (part.textureRef && part.textureBitmap))), color: [...part.color] as ScenePartSnapshot['color'] };
}

/**
 * Read-only debug/e2e hooks on `globalThis`, the same convention as
 * `__ifc_lite_viewer_store__`: live frame stats, resident GPU/CPU bytes and a
 * per-owner scene snapshot for Playwright assertions and console inspection.
 * Installed by the viewport when its renderer is ready, cleared on teardown.
 */
export function installViewportDebugHooks(renderer: Renderer): void {
  const host = globalThis as Record<string, unknown>;
  host.__ifc_lite_render_stats__ = () => ({
    frame: renderer.getFrameStats(),
    gpu: renderer.getScene().getResidentGpuBytes(),
    cpuBytes: renderer.getScene().getResidentCpuBytes(),
  });
  host.__ifc_lite_scene_owner__ = (globalId: number): SceneOwnerSnapshot => {
    const scene = renderer.getScene();
    const flat = scene.getMeshDataPieces(globalId), instanced = scene.getInstancedMeshDataPieces(globalId);
    const corners: number[] = [];
    for (const part of flat ?? instanced ?? []) for (let corner = 0; corner < part.indices.length; corner++) {
      for (let axis = 0; axis < 3; axis++) corners.push(part.positions[part.indices[corner] * 3 + axis] + (part.origin?.[axis] ?? 0));
    }
    const box = scene.getEntityBoundingBox(globalId) ?? scene.getInstancedEntityBounds(globalId);
    const rect = renderer.getCanvas().getBoundingClientRect();
    const centre = box && renderer.getCamera().projectToScreen({ x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 }, rect.width, rect.height);
    return { flat: flat?.map(snapshot) ?? null, instance: !!instanced, corners, screen: centre ? { x: rect.left + centre.x, y: rect.top + centre.y } : null };
  };
}

export function clearViewportDebugHooks(): void {
  const host = globalThis as Record<string, unknown>;
  delete host.__ifc_lite_render_stats__;
  delete host.__ifc_lite_scene_owner__;
}
