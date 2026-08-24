/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `geometryClass` tag that every mesh carries across the WASM boundary.
 *
 * These ordinals are decided in Rust and read here. They cross as a bare
 * `u8` (`rust/wasm-bindings/src/zero_copy/mesh.rs`, `geometry_class()`), so
 * nothing in the type system connects the two sides: if Rust renumbers a
 * class, TypeScript keeps comparing against the old number, silently
 * reclassifying geometry rather than failing. On the Rust side only class 3
 * is named (`rust/processing/src/element.rs:638`,
 * `pub const GEOM_CLASS_LAYER_SLICE: u8 = 3`); 0, 1 and 2 are bare literals
 * there too.
 *
 * This module exists so the TypeScript half of that contract is stated once.
 * Before it, six files across three packages compared `geometryClass`
 * against bare integers -- `apps/viewer/src/lib/type-view-visibility.ts`,
 * `apps/viewer/src/lib/geo/kmz-exporter.ts`,
 * `apps/viewer/src/components/viewer/GLBExportDialog.tsx`,
 * `apps/viewer/src/components/viewer/ViewportContainer.tsx`,
 * `packages/export/src/demesh-session.ts` and `packages/geometry/src/index.ts`
 * -- so a renumbering meant finding all six, and missing one was invisible.
 *
 * What this does NOT do is verify the values against Rust. Only an assertion
 * at the real boundary can do that -- see the note in `geometry-class.test.ts`.
 */

/** Real placed geometry belonging to an occurrence in the model. */
export const GEOM_CLASS_OCCURRENCE = 0;

/** Type-library geometry with no occurrence placing it. */
export const GEOM_CLASS_ORPHAN_TYPE = 1;

/** Type geometry drawn as an instanced duplicate of a placed occurrence. */
export const GEOM_CLASS_INSTANCED_TYPE = 2;

/**
 * One material-layer slice of a layered wall or slab. Placed geometry, like
 * an occurrence -- a model whose layered walls are emitted as slices still
 * "has occurrences" (#1353).
 */
export const GEOM_CLASS_LAYER_SLICE = 3;

/**
 * Reads the tag off a mesh, treating a missing value as an occurrence.
 *
 * The `?? GEOM_CLASS_OCCURRENCE` default is the long-standing behaviour at
 * every call site: meshes produced before the tag existed, and meshes built
 * on the TS side, carry no class and are real geometry.
 */
export function geometryClassOf(mesh: { geometryClass?: number }): number {
  return mesh.geometryClass ?? GEOM_CLASS_OCCURRENCE;
}

/**
 * Is this class PLACED (real-model) geometry?
 *
 * Occurrences and layer slices both are; orphan and instanced type geometry
 * belong to the type library.
 */
export function isPlacedGeometryClass(geometryClass: number): boolean {
  return geometryClass === GEOM_CLASS_OCCURRENCE || geometryClass === GEOM_CLASS_LAYER_SLICE;
}

/** Is this class type-library geometry rather than model geometry? */
export function isTypeLibraryGeometryClass(geometryClass: number): boolean {
  return geometryClass === GEOM_CLASS_ORPHAN_TYPE || geometryClass === GEOM_CLASS_INSTANCED_TYPE;
}
