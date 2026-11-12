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
 *
 * A selection of many ordinary entities is the same shape reached another way
 * (#9835): 100,000 selected walls were 100,000-plus copies, each written and
 * drawn three times a frame. The budget therefore holds for the selection as a
 * whole. Once its individual copies would pass `MERGE_PIECES_ABOVE`, the
 * entities that are not merged on their own pool into ONE merge, so a frame
 * costs the same however many entities the selection holds.
 *
 * A pool keeps its pieces in the selection's order, not grouped by colour. The
 * highlight draws without writing depth, so where translucent base geometry
 * lets several highlighted surfaces overlap on screen, the one drawn last
 * shows. One copy per piece drew them in selection order; a pool split by
 * colour would reorder them and shade those pixels differently. The highlight
 * reads no colour, so nothing needs the split. A pool is therefore one mesh
 * per run of adjacent pieces that share a model and frame origin (see
 * `uploadMergedMeshes`): one mesh for a model with one frame, more when the
 * selection moves between models, origins, 2^24 id pages or fills a buffer.
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
  /** The listed pieces (`Scene.getMeshDataPieceList`) of every entity it holds, when built. Weak, so an evicted piece is not kept alive. */
  pieces: WeakSet<object>;
  /** `Scene.getPickGeometryRevision()` when `pieces` last covered the list; listing a piece bumps it. */
  revision: number;
  /** The authored (non-hydrated) scene meshes in scope of the entities it holds, when built: the pieces they stand for are left out. */
  authored: number;
  /**
   * Set on a pooled merge (#9835): every entity whose pieces it holds, each
   * whole. Absent on the merge of one entity, which its meshes' `expressId` names.
   */
  ids?: ReadonlySet<number>;
}

type HydrationScene = Pick<Scene, 'getMeshes' | 'getMeshDataPieces' | 'getMeshDataPieceList' | 'getPickGeometryRevision' | 'removeMeshesWhere'>;

interface MergedHighlights {
  /** Meshes of single-entity merges, per entity. */
  byEntity: Map<number, Mesh[]>;
  /** Pooled merges, one coverage each. */
  pools: Set<MergedSelectionCoverage>;
}

function mergedHighlights(scene: HydrationScene): MergedHighlights {
  const byEntity = new Map<number, Mesh[]>();
  const pools = new Set<MergedSelectionCoverage>();
  for (const mesh of scene.getMeshes()) {
    const merged = mesh.mergedSelection;
    if (!merged) continue;
    if (merged.ids) {
      pools.add(merged);
      continue;
    }
    const list = byEntity.get(mesh.expressId);
    if (list) list.push(mesh);
    else byEntity.set(mesh.expressId, [mesh]);
  }
  return { byEntity, pools };
}

function pooled(pools: ReadonlySet<MergedSelectionCoverage>, id: number): boolean {
  for (const pool of pools) if (pool.ids!.has(id)) return true;
  return false;
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
function unrepresentedPieces(pieces: readonly MeshData[], existing: ReadonlyMap<string, number>): readonly MeshData[] {
  if (existing.size === 0) return pieces; // nothing stands for anything: no key per piece
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
 * Whether a pooled merge still answers this selection, by the rules of
 * {@link coversSelection} held for every entity in it: each is still selected
 * and visible as a whole product, in the model scope the pool was built for,
 * with the authored meshes it was built beside, and none has had a piece listed
 * since. One entity failing retires the pool, which the next hydration rebuilds.
 */
function poolCoversSelection(
  scene: HydrationScene,
  pool: MergedSelectionCoverage,
  visible: ReadonlySet<number>,
  modelIndex: number | undefined,
  itemFilterExpressId: number | undefined,
  revision: number,
  authoredByEntity: ReadonlyMap<number, number>,
): boolean {
  const ids = pool.ids!;
  if (pool.modelIndex !== modelIndex || (itemFilterExpressId !== undefined && ids.has(itemFilterExpressId))) return false;
  const walk = pool.revision !== revision;
  let authored = 0;
  for (const id of ids) {
    if (!visible.has(id)) return false;
    if (authoredByEntity.size > 0) authored += authoredByEntity.get(id) ?? 0;
    if (walk && scene.getMeshDataPieceList(id)?.some((piece) => !pool.pieces.has(piece))) return false;
  }
  if (authored !== pool.authored) return false;
  pool.revision = revision;
  return true;
}

/**
 * Free the highlight copies a merge is about to replace: stale merged meshes,
 * and individual pieces of an entity that now merges, so nothing draws twice.
 *
 * Runs before the render loop reads `Scene.getMeshes()`, because a buffer
 * destroyed after that would still be drawn this frame.
 *
 * @param visible The selected ids that are drawn (not hidden or isolated away).
 *   A pooled merge holds visible entities only, so one being hidden retires it.
 */
export function retireStaleSelectionHydration(
  scene: HydrationScene,
  selected: ReadonlySet<number>,
  modelIndex: number | undefined,
  itemFilterExpressId: number | undefined,
  itemFilterItemId: number | undefined,
  visible: ReadonlySet<number> = selected,
): void {
  if (selected.size === 0) return;
  const { byEntity: mergedByEntity, pools } = mergedHighlights(scene);
  // Only an entity that is or was merged needs the authored counts, so an
  // ordinary selection skips this walk (independent review of #9238).
  let authoredByEntity: Map<number, number> | undefined;
  const revision = scene.getPickGeometryRevision();
  for (const pool of pools) {
    if (poolCoversSelection(scene, pool, visible, modelIndex, itemFilterExpressId, revision, authoredByEntity ??= authoredMeshCounts(scene, modelIndex))) continue;
    scene.removeMeshesWhere((mesh) => mesh.mergedSelection === pool);
  }
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
    // Its own merge and its individual copies, not a pool it may also be part of.
    if (merged || missing > MERGE_PIECES_ABOVE) scene.removeMeshesWhere((mesh) => mesh.expressId === id && mesh.hydrated === true && !mesh.mergedSelection?.ids);
  }
}

/** A selected entity whose pieces are copied one by one, unless the selection pools. */
interface OrdinaryEntity {
  id: number;
  /** Its pieces in the selection's model scope. */
  pieces: readonly MeshData[];
  /** The ones no scene mesh stands for yet. */
  missing: readonly MeshData[];
}

/**
 * Create the highlight copies the visible selection is missing. Run after
 * {@link retireStaleSelectionHydration}, so a merged mesh found here is current,
 * and like it before the render loop reads `Scene.getMeshes()`: pooling frees
 * the individual copies it replaces.
 *
 * `createPiece` and `createMerged` return whether the upload happened.
 * @param allowPool Whether ordinary entities may pool once they pass the budget
 *   (`SelectionHighlightInputs.pool`); false keeps one copy per piece.
 * @returns false when an upload did not happen, so the caller runs this again.
 */
export function hydrateSelectedEntities(
  scene: HydrationScene,
  visibleSelected: ReadonlySet<number>,
  modelIndex: number | undefined,
  itemFilterExpressId: number | undefined,
  itemFilterItemId: number | undefined,
  createPiece: (piece: MeshData) => boolean,
  createMerged: (pieces: readonly MeshData[], merged: MergedSelectionCoverage) => boolean,
  allowPool = true,
): boolean {
  // Only built with a selection: this avoids iterating 200K+ meshes every frame otherwise.
  if (visibleSelected.size === 0) return true;
  const existingPieceCounts = scenePieceCounts(scene, false);
  const { byEntity: mergedByEntity, pools } = mergedHighlights(scene);
  let complete = true;
  const ordinary: OrdinaryEntity[] = [];
  let ordinaryMissing = 0;

  for (const id of visibleSelected) {
    if (mergedByEntity.has(id) || pooled(pools, id)) continue; // current: the retire step freed every other merge
    const itemId = id === itemFilterExpressId ? itemFilterItemId : undefined; // #4382
    const pieces = scene.getMeshDataPieces(id, modelIndex, itemId);
    if (!pieces || pieces.length === 0) continue;
    const missing = unrepresentedPieces(pieces, existingPieceCounts);
    if (missing.length > MERGE_PIECES_ABOVE) {
      const listed = scene.getMeshDataPieceList(id) ?? pieces;
      const authored = authoredMeshCounts(scene, modelIndex).get(id) ?? 0;
      complete = createMerged(missing, { itemId, modelIndex, pieces: new WeakSet(listed), revision: scene.getPickGeometryRevision(), authored }) && complete;
      continue;
    }
    if (itemId !== undefined) {
      // One item of one product: its copy names that item, so it never pools.
      for (const piece of missing) complete = createPiece(piece) && complete;
      continue;
    }
    ordinary.push({ id, pieces, missing });
    ordinaryMissing += missing.length;
  }
  if (ordinary.length === 0) return complete;

  // The individual copies these entities hold already (a pick's, or an earlier
  // and smaller selection's), plus the ones still to make.
  const individual = (mesh: Mesh): boolean => mesh.hydrated === true && !mesh.mergedSelection && mesh.expressId !== itemFilterExpressId
    && visibleSelected.has(mesh.expressId) && (modelIndex === undefined || mesh.modelIndex === modelIndex);
  let held = 0;
  for (const mesh of scene.getMeshes()) if (individual(mesh)) held++;
  if (!allowPool || held + ordinaryMissing <= MERGE_PIECES_ABOVE) {
    for (const { missing } of ordinary) for (const piece of missing) complete = createPiece(piece) && complete;
    return complete;
  }

  // Past the budget: pool every ordinary entity. Their individual copies go
  // first, so the pool holds each entity whole and nothing draws twice.
  let authoredPieces: Map<string, number> | undefined;
  if (held > 0) {
    scene.removeMeshesWhere(individual);
    authoredPieces = scenePieceCounts(scene, true);
  }
  const authoredByEntity = authoredMeshCounts(scene, modelIndex);
  const ids = new Set<number>();
  const listed = new WeakSet<object>();
  const pieces: MeshData[] = [];
  let authored = 0;
  for (const entity of ordinary) {
    ids.add(entity.id);
    for (const piece of scene.getMeshDataPieceList(entity.id) ?? entity.pieces) listed.add(piece);
    if (authoredByEntity.size > 0) authored += authoredByEntity.get(entity.id) ?? 0;
    for (const piece of authoredPieces ? unrepresentedPieces(entity.pieces, authoredPieces) : entity.missing) pieces.push(piece);
  }
  return createMerged(pieces, { itemId: undefined, modelIndex, pieces: listed, revision: scene.getPickGeometryRevision(), authored, ids }) && complete;
}

/**
 * Upload `pieces` merged and add them to the scene as hydrated highlight meshes.
 * Each mesh takes the lowest id it holds as its `expressId`: the anchor its draw
 * needs to rebuild full ids from the vertex lane (entity-color-table.ts).
 *
 * A pooled merge holds every colour, so its mesh names none: it is opaque and
 * without a finish, which keeps the mesh pass from drawing the whole pool as
 * translucent geometry in one piece's colour. It is only ever drawn selected.
 */
export function addMergedSelectionMeshes(
  scene: Pick<Scene, 'addMesh'>,
  device: GPUDevice,
  pieces: readonly MeshData[],
  merged: MergedSelectionCoverage,
  frameOf: (meshData: MeshData) => IndividualMeshFrame,
): void {
  const pooled = merged.ids !== undefined;
  for (const { representative, vertexBuffer, indexBuffer, indexCount, transform, rteOrigin } of uploadMergedMeshes(device, pieces, frameOf, pooled)) {
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
      color: pooled ? [representative.color[0], representative.color[1], representative.color[2], 1] : representative.color,
      ...(representative.material && !pooled ? { finish: representative.material } : {}),
      hydrated: true,
      mergedSelection: merged,
    });
  }
}
