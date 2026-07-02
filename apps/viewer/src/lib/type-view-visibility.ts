/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model/Types view-switch visibility rule (#957, #1353).
 *
 * geometry_class on each mesh:
 *   0 = placed occurrence
 *   1 = orphan type      — a type RepresentationMap that no occurrence instances
 *   2 = instanced type   — the type-library copy of a shape an occurrence places
 *   3 = material-layer slice (rendered like an occurrence)
 *
 * `Model` view = the real building: placed occurrences + layer slices.
 * `Types`  view = the type library: orphan + instanced type geometry.
 *
 * The subtlety #1353 fixes: an *orphan* type (class 1) used to render in BOTH
 * views, because for a pure type-library file (buildingSMART annex-E, zero
 * occurrences) it is the only geometry and hiding it would blank the screen.
 * But a real model authored in Bonsai can also carry unplaced `IfcXxxType`
 * definitions with geometry; those are type-library content and should NOT
 * clutter the Model view — they belong in the Types view. So an orphan type is
 * shown in Model view ONLY when the model has no placed occurrences at all.
 */
export type TypeViewMode = 'model' | 'types';

/**
 * Does this mesh's geometry_class count as PLACED (real-model) geometry?
 * Class 0 (occurrence) AND class 3 (material-layer slice) are both placed —
 * a model whose layered walls/slabs are emitted as slices still "has
 * occurrences", so orphan type-library geometry must hide in Model view. (#1353)
 */
export function meshClassIsPlaced(geometryClass: number): boolean {
  return geometryClass === 0 || geometryClass === 3;
}

export function isMeshVisibleInViewMode(
  geometryClass: number,
  viewMode: TypeViewMode,
  hasOccurrenceGeometry: boolean,
): boolean {
  if (viewMode === 'types') {
    // Type library only: orphan (1) + instanced (2) type geometry.
    return geometryClass === 1 || geometryClass === 2;
  }
  // Model view.
  if (geometryClass === 2) return false; // instanced-type duplicates never show here
  if (geometryClass === 1) {
    // Orphan type-library geometry: hide it once the model has real placed
    // geometry (it lives in the Types view); keep it only for pure type-library
    // files so the Model view isn't empty.
    return !hasOccurrenceGeometry;
  }
  // class 0 (occurrence) and class 3 (layer slice) are the real model.
  return true;
}
