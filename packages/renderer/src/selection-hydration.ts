/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Keeps the selected entities' highlight copies in `Scene.meshes`, for the
 * render loop. These copies are built lazily, one per piece, which is right
 * for a window or a layered wall and wrong for one object holding tens of
 * thousands of pieces: three buffers and a bind group per piece, then a write
 * and three draws per piece on every later frame (#9192). Past
 * `MERGE_PIECES_ABOVE` the pieces merge, so a selected entity costs per colour
 * and frame, and a current merge is recognised without walking its pieces.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { MERGE_PIECES_ABOVE, uploadMergedMeshes, type IndividualMeshFrame } from './individual-mesh-upload.js';
import { pickPieceKey } from './pick-mesh-budget.js';
import type { Scene } from './scene.js';
import type { Mesh } from './types.js';

type HydrationScene = Pick<Scene, 'getMeshes' | 'getMeshDataPieces' | 'getMeshDataPieceListLength' | 'evictHighlightMeshes'>;

function mergedMeshesByEntity(scene: HydrationScene): Map<number, Mesh[]> {
  const merged = new Map<number, Mesh[]>();
  for (const mesh of scene.getMeshes()) {
    if (!mesh.mergedSelection) continue;
    const list = merged.get(mesh.expressId);
    if (list) list.push(mesh);
    else merged.set(mesh.expressId, [mesh]);
  }
  return merged;
}

/**
 * Free the highlight copies a merge is about to replace: stale merged meshes,
 * and individual pieces of an entity that now merges, so nothing draws twice.
 * A merge whose entity's list shrank stays current, as a cold-evicted piece's
 * individual copy would: its pieces come back when the bucket restores.
 *
 * Runs before the render loop reads `Scene.getMeshes()`, because a buffer
 * destroyed after that would still be drawn this frame.
 */
export function retireStaleSelectionHydration(
  scene: HydrationScene,
  selected: ReadonlySet<number>,
  modelIndex: number | undefined,
  itemFilterExpressId: number | undefined,
  itemFilterItemId: number | undefined,
): void {
  if (selected.size === 0) return;
  const mergedByEntity = mergedMeshesByEntity(scene);
  for (const id of selected) {
    const listLength = scene.getMeshDataPieceListLength(id);
    const merged = mergedByEntity.get(id)?.filter((mesh) => modelIndex === undefined || mesh.modelIndex === modelIndex) ?? [];
    if (merged.length === 0 && listLength <= MERGE_PIECES_ABOVE) continue;
    const itemId = id === itemFilterExpressId ? itemFilterItemId : undefined;
    if (merged.length > 0 && merged.every((mesh) => mesh.mergedSelection!.itemId === itemId && mesh.mergedSelection!.listLength >= listLength)) continue;
    const pieces = scene.getMeshDataPieces(id, modelIndex, itemId)?.length ?? 0;
    if (merged.length > 0 || pieces > MERGE_PIECES_ABOVE) scene.evictHighlightMeshes(id, true);
  }
}

/**
 * Create the highlight copies the visible selection is missing. Run after
 * {@link retireStaleSelectionHydration}, so a merged mesh found here is current.
 */
export function hydrateSelectedEntities(
  scene: HydrationScene,
  visibleSelected: ReadonlySet<number>,
  modelIndex: number | undefined,
  itemFilterExpressId: number | undefined,
  itemFilterItemId: number | undefined,
  createPiece: (piece: MeshData) => void,
  createMerged: (pieces: readonly MeshData[], merged: NonNullable<Mesh['mergedSelection']>) => void,
): void {
  // Only built with a selection: this avoids iterating 200K+ meshes every frame otherwise.
  if (visibleSelected.size === 0) return;
  const existingPieceCounts = new Map<string, number>();
  for (const mesh of scene.getMeshes()) {
    const key = pickPieceKey(mesh);
    existingPieceCounts.set(key, (existingPieceCounts.get(key) ?? 0) + 1);
  }
  const mergedByEntity = mergedMeshesByEntity(scene);

  for (const id of visibleSelected) {
    if (mergedByEntity.get(id)?.some((mesh) => modelIndex === undefined || mesh.modelIndex === modelIndex)) continue;
    const itemId = id === itemFilterExpressId ? itemFilterItemId : undefined; // #4382
    const pieces = scene.getMeshDataPieces(id, modelIndex, itemId);
    if (!pieces || pieces.length === 0) continue;
    if (pieces.length > MERGE_PIECES_ABOVE) {
      createMerged(pieces, { listLength: scene.getMeshDataPieceListLength(id), itemId });
      continue;
    }
    const seenOrdinalsByKey = new Map<string, number>();
    for (const piece of pieces) {
      const key = pickPieceKey(piece);
      const ordinal = seenOrdinalsByKey.get(key) ?? 0;
      seenOrdinalsByKey.set(key, ordinal + 1);
      if (ordinal < (existingPieceCounts.get(key) ?? 0)) continue;
      createPiece(piece);
    }
  }
}

/** Upload `pieces` merged and add them to the scene as hydrated highlight meshes. */
export function addMergedSelectionMeshes(
  scene: Pick<Scene, 'addMesh'>,
  device: GPUDevice,
  pieces: readonly MeshData[],
  merged: NonNullable<Mesh['mergedSelection']>,
  frameOf: (meshData: MeshData) => IndividualMeshFrame,
): void {
  for (const { representative, vertexBuffer, indexBuffer, indexCount, transform, rteOrigin } of uploadMergedMeshes(device, pieces, frameOf)) {
    scene.addMesh({
      expressId: representative.expressId,
      modelIndex: representative.modelIndex,
      // The item only when an item filter built this: whole-product merges have none.
      geometryItemId: merged.itemId,
      vertexBuffer,
      indexBuffer,
      indexCount,
      transform,
      rteOrigin,
      color: representative.color,
      ...(representative.material ? { finish: representative.material } : {}),
      hydrated: true,
      mergedSelection: merged,
    });
  }
}
