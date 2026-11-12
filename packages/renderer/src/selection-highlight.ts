/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The selection as the render loop sees it, kept across frames (#9835).
 *
 * A frame used to redo everything the selection implies: build the id set,
 * compare it with last frame's, look up every selected entity's pieces and
 * walk the scene meshes for the ones to highlight. That is work per selected
 * entity on every frame, including the frames of an orbit where nothing about
 * the selection changes, and it is what made a large selection slow to turn.
 *
 * Here a frame only asks whether an input changed: the selection, hide/isolate,
 * the model or item scope, the scene's pick geometry or its mesh list. While
 * none did, the highlight meshes of the last frame are the answer.
 */

import type { MeshData } from '@ifc-lite/geometry';
import { hydrateSelectedEntities, retireStaleSelectionHydration, type MergedSelectionCoverage } from './selection-hydration.js';
import type { Scene } from './scene.js';
import type { Mesh } from './types.js';

const NO_IDS: ReadonlySet<number> = new Set<number>();

/**
 * The ids of an unchanged `selectedIds` object re-checked per frame. A caller
 * may edit its Set in place to other ids of the same count, which neither the
 * object nor its size shows, so a frame still reads this many of them: a
 * selection up to this size is compared whole on every frame, a larger one in
 * turns, an edit to it being seen within `size / SELECTION_IDS_VERIFIED_PER_FRAME` frames.
 */
export const SELECTION_IDS_VERIFIED_PER_FRAME = 4096;

/**
 * `RenderOptions.selectedId` and `selectedIds` as one set, rebuilt only when
 * they change. A frame that passes the same `selectedIds` object at the same
 * size, with the same `selectedId`, gets the previous set back after a bounded
 * re-check ({@link SELECTION_IDS_VERIFIED_PER_FRAME}), not a walk of the selection.
 * Anything else is compared by content, so a copy of an unchanged selection
 * (a capture, a fresh Set from a store) keeps the set and its version.
 */
export class SelectionSnapshot {
  private ids: ReadonlySet<number> = NO_IDS;
  private version = 0;
  private sourceIds: ReadonlySet<number> | undefined;
  private sourceSize = 0;
  private sourceId: number | null = null;
  /** Where the bounded re-check of `sourceIds` stopped; a Set's iterator survives edits to it. */
  private cursor: Iterator<number> | undefined;

  /** The selected ids for this frame. The returned set is never mutated: a change yields a new one. */
  update(selectedId: number | null | undefined, selectedIds: ReadonlySet<number> | undefined): ReadonlySet<number> {
    const id = selectedId ?? null;
    const size = selectedIds?.size ?? 0;
    if (selectedIds === this.sourceIds && size === this.sourceSize && id === this.sourceId && this.verified(selectedIds)) return this.ids;
    this.sourceIds = selectedIds;
    this.sourceSize = size;
    this.sourceId = id;
    this.cursor = undefined;
    if (!this.holds(id, selectedIds)) {
      const next = new Set<number>();
      if (id !== null) next.add(id);
      if (selectedIds) for (const each of selectedIds) next.add(each);
      this.ids = next;
      this.version++;
    }
    return this.ids;
  }

  /** Bumped whenever {@link update} returned a different set of ids. */
  getVersion(): number {
    return this.version;
  }

  /** Re-check the next ids of the same-sized `selectedIds` object; false as soon as one is not in the snapshot. */
  private verified(selectedIds: ReadonlySet<number> | undefined): boolean {
    if (!selectedIds || selectedIds.size === 0) return true;
    const ids = this.ids;
    const cursor = this.cursor ??= selectedIds.values();
    for (let budget = SELECTION_IDS_VERIFIED_PER_FRAME; budget > 0; budget--) {
      const next = cursor.next();
      if (next.done) {
        this.cursor = undefined; // a full pass: start over next frame
        return true;
      }
      if (!ids.has(next.value)) return false;
    }
    return true;
  }

  private holds(id: number | null, selectedIds: ReadonlySet<number> | undefined): boolean {
    const ids = this.ids;
    const extra = id !== null && !selectedIds?.has(id) ? 1 : 0;
    if ((selectedIds?.size ?? 0) + extra !== ids.size) return false;
    if (id !== null && !ids.has(id)) return false;
    if (selectedIds) for (const each of selectedIds) if (!ids.has(each)) return false;
    return true;
  }
}

/** What decides this frame's highlight. The two versions stand for the content of the sets beside them. */
export interface SelectionHighlightInputs {
  /** {@link SelectionSnapshot.update}'s set. */
  selected: ReadonlySet<number>;
  /** {@link SelectionSnapshot.getVersion}. */
  selectionVersion: number;
  hiddenIds: ReadonlySet<number> | null | undefined;
  isolatedIds: ReadonlySet<number> | null | undefined;
  /** `VisibilityEpochTracker`'s version for `hiddenIds` and `isolatedIds`. */
  visibilityVersion: number;
  modelIndex: number | undefined;
  itemFilterExpressId: number | undefined;
  itemFilterItemId: number | undefined;
}

type HighlightScene = Pick<Scene, 'getMeshes' | 'getMeshDataPieces' | 'getMeshDataPieceList' | 'getPickGeometryRevision'
  | 'removeMeshesWhere' | 'disposeHydratedMeshesExcept' | 'setInstancedSelection'>;

/** The selected ids that are neither hidden nor isolated away; the selection itself when no filter is on. */
function visibleSelection(frame: SelectionHighlightInputs): ReadonlySet<number> {
  const hidden = frame.hiddenIds && frame.hiddenIds.size > 0 ? frame.hiddenIds : null;
  const isolated = frame.isolatedIds ?? null;
  if (!hidden && !isolated) return frame.selected;
  const visible = new Set<number>();
  for (const id of frame.selected) {
    if (hidden?.has(id) || (isolated && !isolated.has(id))) continue;
    visible.add(id);
  }
  return visible;
}

/**
 * Owns the selection highlight between frames: which scene meshes draw it, and
 * when the copies behind them have to be freed or built.
 *
 * {@link resolve} runs before a frame reads `Scene.getMeshes()`: it frees and
 * replaces copies, and a buffer freed after the frame wrote or bound it is
 * rejected at submit.
 */
export class SelectionHighlight {
  private selectionVersion = -1;
  private modelIndex: number | undefined;
  private itemFilterExpressId: number | undefined;
  private itemFilterItemId: number | undefined;
  private visibilityVersion = -1;
  private revision = -1;
  private sceneMeshes: readonly Mesh[] | null = null;
  private sceneMeshCount = 0;
  private visible: ReadonlySet<number> = NO_IDS;
  private drawn: readonly Mesh[] = [];
  /** The copies were retired for a change and have not been rebuilt, or a rebuild failed and is owed. */
  private pending = false;

  /**
   * The scene meshes that draw this frame's highlight. While every input is
   * what the last call saw, that is last frame's list. Otherwise the copies the
   * selection no longer wants are freed, the selection is mirrored onto the
   * instanced occurrences, and the copies the visible selection is missing are
   * built. `createPiece` and `createMerged` say whether their upload happened;
   * one that did not is retried next frame.
   */
  resolve(
    scene: HighlightScene,
    frame: SelectionHighlightInputs,
    createPiece: (piece: MeshData) => boolean,
    createMerged: (pieces: readonly MeshData[], merged: MergedSelectionCoverage) => boolean,
  ): readonly Mesh[] {
    if (this.changed(scene, frame)) this.retire(scene, frame);
    if (!this.pending) return this.drawn;
    const { visible, modelIndex, itemFilterExpressId, itemFilterItemId } = this;
    const complete = hydrateSelectedEntities(scene, visible, modelIndex, itemFilterExpressId, itemFilterItemId, createPiece, createMerged);
    this.drawn = visible.size > 0
      ? scene.getMeshes().filter((mesh) => visible.has(mesh.expressId)
        && (modelIndex === undefined || mesh.modelIndex === modelIndex)
        && (mesh.expressId !== itemFilterExpressId || mesh.geometryItemId === itemFilterItemId)) // #4382
      : [];
    this.pending = !complete;
    this.sceneMeshes = scene.getMeshes();
    this.sceneMeshCount = this.sceneMeshes.length;
    return this.drawn;
  }

  private changed(scene: HighlightScene, frame: SelectionHighlightInputs): boolean {
    // `Scene.meshes` only ever grows by a push or is replaced, so the array and its length name its content.
    const meshes = scene.getMeshes();
    return frame.selectionVersion !== this.selectionVersion || frame.modelIndex !== this.modelIndex
      || frame.itemFilterExpressId !== this.itemFilterExpressId || frame.itemFilterItemId !== this.itemFilterItemId
      || frame.visibilityVersion !== this.visibilityVersion || scene.getPickGeometryRevision() !== this.revision
      || meshes !== this.sceneMeshes || meshes.length !== this.sceneMeshCount;
  }

  /** Free the highlight copies this frame's selection no longer wants, and mirror the selection onto the instanced occurrences. */
  private retire(scene: HighlightScene, frame: SelectionHighlightInputs): void {
    const scopeChanged = frame.selectionVersion !== this.selectionVersion || frame.modelIndex !== this.modelIndex
      || frame.itemFilterExpressId !== this.itemFilterExpressId || frame.itemFilterItemId !== this.itemFilterItemId;
    this.selectionVersion = frame.selectionVersion;
    this.modelIndex = frame.modelIndex;
    this.itemFilterExpressId = frame.itemFilterExpressId;
    this.itemFilterItemId = frame.itemFilterItemId;
    this.visibilityVersion = frame.visibilityVersion;
    this.revision = scene.getPickGeometryRevision();
    this.visible = visibleSelection(frame);
    // The per-instance selected flag; the scene diffs it, and an instanced upload bumps the revision.
    scene.setInstancedSelection(frame.selected, frame.itemFilterExpressId, frame.itemFilterItemId);
    // Copies of entities that left the selection (or its model / item scope) duplicate
    // geometry a batch already draws: freed here, or they pile up in VRAM and, for a
    // transparent entity, blend a second time over its batch. Only on such a change:
    // a pick's own copies of unselected entities stay until the selection moves.
    if (scopeChanged) scene.disposeHydratedMeshesExcept(frame.selected, frame.modelIndex, frame.itemFilterExpressId, frame.itemFilterItemId);
    retireStaleSelectionHydration(scene, frame.selected, frame.modelIndex, frame.itemFilterExpressId, frame.itemFilterItemId, this.visible);
    this.pending = true;
  }
}
