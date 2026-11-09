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
 * and frame. A merge records what it covers (scope and listed pieces), and is
 * re-checked against the entity's list only after pick geometry changed.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { MERGE_PIECES_ABOVE, uploadMergedMeshes, type IndividualMeshFrame } from './individual-mesh-upload.js';
import { pickPieceKey } from './pick-mesh-budget.js';
import type { Scene } from './scene.js';
import type { Mesh } from './types.js';

/**
 * What a merged selection highlight was built from (#9192), so staleness is an
 * identity check rather than a count: the selection scope it answers, and the
 * entity's listed pieces at build time. Shared by every mesh of one merge.
 */
export interface MergedSelectionCoverage {
  /** The item filter it was built for; undefined = the whole product. */
  itemId: number | undefined;
  /** The model scope it was built for; undefined = every model. */
  modelIndex: number | undefined;
  /** The entity's listed pieces (`Scene.getMeshDataPieceList`) when built. Weak, so an evicted piece is not kept alive. */
  pieces: WeakSet<object>;
  /** `Scene.getPickGeometryRevision()` when `pieces` last covered the list; listing a piece bumps it. */
  revision: number;
  /** The entity's authored (non-hydrated) scene meshes in scope when built: the pieces they stand for are left out. */
  authored: number;
}

type HydrationScene = Pick<Scene, 'getMeshes' | 'getMeshDataPieces' | 'getMeshDataPieceList' | 'getPickGeometryRevision' | 'evictHighlightMeshes'>;

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

/** Scene meshes per `pickPieceKey`; `authoredOnly` leaves out hydrated highlight copies. */
function scenePieceCounts(scene: HydrationScene, authoredOnly: boolean): Map<string, number> {
  const counts = new Map<string, number>();
  for (const mesh of scene.getMeshes()) {
    if (authoredOnly && mesh.hydrated) continue;
    const key = pickPieceKey(mesh);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Authored (non-hydrated) scene meshes per entity, within `modelIndex` (undefined = every model). */
function authoredMeshCounts(scene: HydrationScene, modelIndex: number | undefined): Map<number, number> {
  const counts = new Map<number, number>();
  for (const mesh of scene.getMeshes()) {
    if (mesh.hydrated || (modelIndex !== undefined && mesh.modelIndex !== modelIndex)) continue;
    counts.set(mesh.expressId, (counts.get(mesh.expressId) ?? 0) + 1);
  }
  return counts;
}

/**
 * The pieces no scene mesh stands for yet: the first N pieces of a (model, id)
 * are taken by its N existing meshes, the rule per-piece hydration has always
 * used, so an authored `Renderer.addMesh` copy is never drawn twice.
 */
function unrepresentedPieces(pieces: readonly MeshData[], existing: ReadonlyMap<string, number>): MeshData[] {
  const seen = new Map<string, number>();
  const missing: MeshData[] = [];
  for (const piece of pieces) {
    const key = pickPieceKey(piece);
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    if (ordinal >= (existing.get(key) ?? 0)) missing.push(piece);
  }
  return missing;
}

/**
 * Whether `merge` still answers this selection: built for the same item filter,
 * model scope and authored meshes, and no piece listed for the entity since
 * that it lacks. A
 * piece only leaving the list (cold eviction) keeps it current, as it would a
 * per-piece copy. A count cannot tell which pieces are listed, so the list is
 * walked by identity, and only after pick geometry changed.
 */
function coversSelection(
  merge: MergedSelectionCoverage,
  listed: readonly MeshData[] | undefined,
  modelIndex: number | undefined,
  itemId: number | undefined,
  revision: number,
  authored: number,
): boolean {
  if (merge.itemId !== itemId || merge.modelIndex !== modelIndex || merge.authored !== authored) return false;
  if (merge.revision === revision) return true;
  if (listed?.some((piece) => !merge.pieces.has(piece))) return false;
  merge.revision = revision;
  return true;
}

/**
 * Free the highlight copies a merge is about to replace: stale merged meshes,
 * and individual pieces of an entity that now merges, so nothing draws twice.
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
  // Only an entity that is or was merged needs the authored counts, so an
  // ordinary selection skips this walk (independent review of #9238).
  let authoredByEntity: Map<number, number> | undefined;
  const revision = scene.getPickGeometryRevision();
  let authoredPieceCounts: Map<string, number> | undefined;
  for (const id of selected) {
    const listed = scene.getMeshDataPieceList(id);
    const merged = mergedByEntity.get(id);
    if (!merged && (listed?.length ?? 0) <= MERGE_PIECES_ABOVE) continue;
    const itemId = id === itemFilterExpressId ? itemFilterItemId : undefined;
    const authored = (authoredByEntity ??= authoredMeshCounts(scene, modelIndex)).get(id) ?? 0;
    if (merged?.every((mesh) => coversSelection(mesh.mergedSelection!, listed, modelIndex, itemId, revision, authored))) continue;
    const pieces = scene.getMeshDataPieces(id, modelIndex, itemId) ?? [];
    const missing = authored === 0 ? pieces.length : unrepresentedPieces(pieces, authoredPieceCounts ??= scenePieceCounts(scene, true)).length;
    if (merged || missing > MERGE_PIECES_ABOVE) scene.evictHighlightMeshes(id, true);
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
  createMerged: (pieces: readonly MeshData[], merged: MergedSelectionCoverage) => void,
): void {
  // Only built with a selection: this avoids iterating 200K+ meshes every frame otherwise.
  if (visibleSelected.size === 0) return;
  const existingPieceCounts = scenePieceCounts(scene, false);
  const mergedByEntity = mergedMeshesByEntity(scene);

  for (const id of visibleSelected) {
    if (mergedByEntity.has(id)) continue; // current: the retire step freed every other merge
    const itemId = id === itemFilterExpressId ? itemFilterItemId : undefined; // #4382
    const pieces = scene.getMeshDataPieces(id, modelIndex, itemId);
    if (!pieces || pieces.length === 0) continue;
    const missing = unrepresentedPieces(pieces, existingPieceCounts);
    if (missing.length > MERGE_PIECES_ABOVE) {
      const listed = scene.getMeshDataPieceList(id) ?? pieces;
      const authored = authoredMeshCounts(scene, modelIndex).get(id) ?? 0;
      createMerged(missing, { itemId, modelIndex, pieces: new WeakSet(listed), revision: scene.getPickGeometryRevision(), authored });
      continue;
    }
    for (const piece of missing) createPiece(piece);
  }
}

/** Upload `pieces` merged and add them to the scene as hydrated highlight meshes. */
export function addMergedSelectionMeshes(
  scene: Pick<Scene, 'addMesh'>,
  device: GPUDevice,
  pieces: readonly MeshData[],
  merged: MergedSelectionCoverage,
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
