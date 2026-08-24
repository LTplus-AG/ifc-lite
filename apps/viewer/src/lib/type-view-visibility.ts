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
 *
 * The ordinals themselves come from Rust and are named in
 * `@ifc-lite/geometry/geometry-class`, so this file no longer spells them out
 * as bare integers.
 */
import {
  GEOM_CLASS_INSTANCED_TYPE,
  GEOM_CLASS_OCCURRENCE,
  GEOM_CLASS_ORPHAN_TYPE,
  geometryClassOf,
  isPlacedGeometryClass,
  isTypeLibraryGeometryClass,
} from '@ifc-lite/geometry/geometry-class';

export type TypeViewMode = 'model' | 'types';

/**
 * Does this mesh's geometry_class count as PLACED (real-model) geometry?
 * Class 0 (occurrence) AND class 3 (material-layer slice) are both placed —
 * a model whose layered walls/slabs are emitted as slices still "has
 * occurrences", so orphan type-library geometry must hide in Model view. (#1353)
 *
 * Kept as this module's name for its several callers; the rule itself lives
 * with the ordinals it depends on.
 */
export function meshClassIsPlaced(geometryClass: number): boolean {
  return isPlacedGeometryClass(geometryClass);
}

/**
 * Is this mesh anything OTHER than a placed occurrence?
 *
 * Deliberately not `isTypeLibraryGeometryClass`, which is orphan + instanced
 * type geometry only. This is the broader `!== occurrence`, so a
 * material-layer slice counts too — which is the existing behaviour of the
 * Model/Types toggle gate in `ViewportContainer`, preserved exactly rather
 * than tightened here. Whether a layered wall alone should offer that toggle
 * is a separate question from naming the ordinal.
 */
export function meshIsNonOccurrence(mesh: { geometryClass?: number }): boolean {
  return geometryClassOf(mesh) !== GEOM_CLASS_OCCURRENCE;
}

export function isMeshVisibleInViewMode(
  geometryClass: number,
  viewMode: TypeViewMode,
  hasOccurrenceGeometry: boolean,
): boolean {
  if (viewMode === 'types') {
    // Type library only: orphan + instanced type geometry.
    return isTypeLibraryGeometryClass(geometryClass);
  }
  // Model view.
  if (geometryClass === GEOM_CLASS_INSTANCED_TYPE) return false; // duplicates never show here
  if (geometryClass === GEOM_CLASS_ORPHAN_TYPE) {
    // Orphan type-library geometry: hide it once the model has real placed
    // geometry (it lives in the Types view); keep it only for pure type-library
    // files so the Model view isn't empty.
    return !hasOccurrenceGeometry;
  }
  // class 0 (occurrence) and class 3 (layer slice) are the real model.
  return true;
}

/**
 * The real-model subset of a mesh list — what a 2D drawing cuts (#2058).
 *
 * `geometryResult.meshes` carries the whole scene, type library included, and
 * the Model/Types switch is a 3D control: a standard 2D section, plan or
 * sketch underlay always draws the building. So this resolves
 * `hasOccurrenceGeometry` over the list and applies `isMeshVisibleInViewMode`
 * pinned to `'model'` — one predicate for every consumer rather than a second,
 * differently-shaped guard that drifts. A pure type-library file (no placed
 * occurrence at all) still keeps its orphan class-1 geometry, exactly as the
 * Model view does.
 */
export function selectModelMeshes<T extends { geometryClass?: number }>(meshes: readonly T[]): T[] {
  const hasOccurrenceGeometry = meshes.some((m) => meshClassIsPlaced(geometryClassOf(m)));
  return meshes.filter((m) =>
    isMeshVisibleInViewMode(geometryClassOf(m), 'model', hasOccurrenceGeometry),
  );
}

/**
 * `selectModelMeshes`'s gate, keyed by express id instead of by mesh — for
 * anything that reaches a 2D drawing WITHOUT going through the mesh list
 * (construction-projection profiles, `extractProfiles` output). Filtering
 * `meshesToProcess` alone leaves that second route ungated: if a profile ever
 * carries the express id of type-library geometry (today `extractProfiles`
 * only walks `IfcProduct` entities, so it doesn't — but that is a property of
 * the Rust extractor, not of this filter, and nothing pins it), the profile
 * would project the exact geometry the mesh filter just removed from the cut.
 *
 * Reuses `isMeshVisibleInViewMode` — the SAME predicate `selectModelMeshes`
 * applies — so the two filter sites can't drift back apart; call this with
 * `geometryResult.meshes` and it derives one id → verdict lookup for every
 * consumer.
 *
 * An id with NO mesh at all (e.g. an `IfcSpace` with a body representation but
 * no rendered mesh) never went through the class gate in the first place, so
 * it passes through unaffected here — hiding/isolation/`isTypeVisible` are
 * what govern it, exactly as before this function existed.
 */
export function buildModelViewIdFilter(
  meshes: readonly { expressId: number; geometryClass?: number }[],
): (expressId: number) => boolean {
  const hasOccurrenceGeometry = meshes.some((m) => meshClassIsPlaced(geometryClassOf(m)));
  const classById = new Map<number, number>();
  for (const m of meshes) {
    // An express id's geometryClass is consistent across its own mesh
    // entries (e.g. material-layer slices are all class 3), so first-write
    // is as good as any.
    if (!classById.has(m.expressId)) classById.set(m.expressId, geometryClassOf(m));
  }
  return (expressId: number) => {
    const geometryClass = classById.get(expressId);
    return geometryClass === undefined || isMeshVisibleInViewMode(geometryClass, 'model', hasOccurrenceGeometry);
  };
}
