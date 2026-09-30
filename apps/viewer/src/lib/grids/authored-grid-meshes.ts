/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The grids authored this session, drawn in 3D (charter #6232, D3).
 *
 * A design grid is lines, not a body: the wasm mesher gives an IfcGrid no
 * mesh, and the symbolic overlay that draws a FILE's grid axes walks the
 * source bytes, which a grid created in the overlay is not in. So an authored
 * grid would be in the tree, on the snap and in the export, and invisible.
 * This draws its axes as thin strips on the storey, on the `grids` authoring
 * overlay channel, recomputed whenever the model is edited (place, undo, redo,
 * delete, a collab peer's edit), so what is drawn is what the model holds.
 * File grids are left to the symbolic overlay: only overlay-created ones here.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { extractGridAxesForStorey } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import { commandGhostId } from '@/lib/commands/modeling/ghost';
import { mergeGhostMeshes, prismGhostMesh, segmentOutline } from '@/lib/commands/modeling/ghost-shapes';
import { buildStoreyWorkplane } from '@/lib/commands/modeling/workplane';

/** Strips stand 0.03 to 0.09 m above the storey level: a floor finish's top is often a few centimetres up, and a strip inside it is hidden. */
const STRIP_WIDTH = 0.08;
const STRIP_BASE = 0.03;
const STRIP_TOP = 0.09;
const GRID_COLOR: [number, number, number, number] = [0.05, 0.45, 0.95, 1];
/** The command ghosts' pick guard hides this many ids from the command pointer; the grids take the last, so it never snaps to a strip. */
export const GRID_OVERLAY_ID_INDEX = 3;

/** Every live overlay-created grid of every model, as one mesh; empty when there are none. */
export function authoredGridMeshes(s: ViewerState): MeshData[] {
  const id = commandGhostId(s, GRID_OVERLAY_ID_INDEX);
  const strips: MeshData[] = [];
  for (const [modelId, view] of s.mutationViews) {
    const store = s.models.get(modelId)?.ifcDataStore;
    const hierarchy = store?.spatialHierarchy;
    if (!store || !hierarchy) continue;
    const authored = view.getNewEntities().filter((e) => e.type.toUpperCase() === 'IFCGRID' && !view.isDeleted(e.expressId));
    if (authored.length === 0) continue;
    const byStorey = new Map<number, Set<number>>();
    for (const { expressId } of authored) {
      const storeyId = hierarchy.elementToStorey.get(expressId);
      if (storeyId === undefined) continue;
      (byStorey.get(storeyId) ?? byStorey.set(storeyId, new Set()).get(storeyId)!).add(expressId);
    }
    for (const [storeyId, gridIds] of byStorey) {
      const plane = buildStoreyWorkplane(s, modelId, storeyId, 0);
      if ('refused' in plane) continue;
      for (const axis of extractGridAxesForStorey(store, storeyId, view).axes) {
        if (!gridIds.has(axis.gridId)) continue;
        const strip = prismGhostMesh(plane, segmentOutline(axis.a, axis.b, STRIP_WIDTH), STRIP_BASE, STRIP_TOP, id);
        if (strip) strips.push(strip);
      }
    }
  }
  const merged = mergeGhostMeshes(strips, id, GRID_COLOR);
  return merged ? [merged] : [];
}

/**
 * A key that changes when, and only when, the drawn strips do: the exact
 * vertex bits, hashed (FNV-1a over the 32-bit words) with the vertex count.
 * A sum of coordinates is not enough: a grid moved along the plan keeps its
 * sum, and a grid moved by (1, 1) in storey coordinates renders shifted by
 * (1, -1) in render space.
 */
export function gridMeshesKey(meshes: readonly MeshData[]): string {
  return meshes.map((m) => {
    const words = new Uint32Array(m.positions.buffer, m.positions.byteOffset, m.positions.length);
    let hash = 0x811c9dc5;
    for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 0x01000193) >>> 0;
    return `${m.positions.length}:${hash.toString(16)}`;
  }).join('|');
}
