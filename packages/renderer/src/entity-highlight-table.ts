/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selection and hover highlight as a GPU test (#10264 S3).
 *
 * The highlight used to draw per-entity copies built from the CPU pieces of
 * the selected entities. Instead, a colour batch holding a highlighted entity
 * is drawn again whole, from its own GPU buffers, and each fragment asks
 * whether the entity behind it (the vertex lane, as for hide/isolate) is one
 * to highlight. Two per-draw modes, in the mesh uniform's `flags.x`:
 *
 * - {@link MESH_FLAG_HIGHLIGHTED_ENTITIES}: keep the entities of the shared
 *   highlight table, the visible selection (bound beside the hide/isolate
 *   table, `section-exclusions.ts`). Used by the selection highlight draw and
 *   the selection outline masks.
 * - {@link MESH_FLAG_ONE_ENTITY}: keep the one entity named in `flags.w`. Used
 *   by the hover outline mask, which follows the pointer and so must not
 *   rewrite a shared table.
 *
 * Image layout (u32): `[count, ids ascending...]`. An all-zero buffer
 * highlights nothing.
 */

/** `flags.x` bit: keep only fragments whose entity is in the highlight table. */
export const MESH_FLAG_HIGHLIGHTED_ENTITIES = 128;
/** `flags.x` bit: keep only fragments whose entity is `flags.w`. */
export const MESH_FLAG_ONE_ENTITY = 256;

/** Pack the highlighted ids: full scene ids that fit the u32 lane, sorted ascending. */
export function entityHighlightImage(ids: Iterable<number>): Uint32Array {
  const keys: number[] = [];
  for (const id of ids) if (Number.isInteger(id) && id >= 0 && id < 0xFFFFFFFF) keys.push(id);
  const image = new Uint32Array(keys.length + 1);
  image[0] = keys.length;
  image.set(keys, 1);
  image.subarray(1).sort();
  return image;
}

/** CPU mirror of {@link entityHighlightWgsl}'s `entityHighlighted`, so the table's reading is testable without a device. */
export function entityHighlightedInImage(image: Uint32Array, id: number): boolean {
  let lo = 0;
  let hi = image[0] ?? 0;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const key = image[mid + 1]!;
    if (key === id) return true;
    if (key < id) lo = mid + 1; else hi = mid;
  }
  return false;
}

/** CPU mirror of `highlightKeeps`: whether a draw with these flags keeps a fragment of entity `id`. */
export function highlightKeepsFragment(image: Uint32Array, flagsX: number, flagsW: number, id: number): boolean {
  if ((flagsX & MESH_FLAG_HIGHLIGHTED_ENTITIES) !== 0 && !entityHighlightedInImage(image, id)) return false;
  if ((flagsX & MESH_FLAG_ONE_ENTITY) !== 0 && id !== flagsW) return false;
  return true;
}

/**
 * The shader half. Reads `entityHighlight`, which `sectionExclusionsWgsl`
 * declares in the shared entity-table group.
 */
export const entityHighlightWgsl = `
fn entityHighlighted(id: u32) -> bool {
  var lo = 0u;
  var hi = entityHighlight[0];
  while (lo < hi) {
    let mid = lo + (hi - lo) / 2u;
    let key = entityHighlight[mid + 1u];
    if (key == id) { return true; }
    if (key < id) { lo = mid + 1u; } else { hi = mid; }
  }
  return false;
}
fn highlightKeeps(flags: vec4<u32>, id: u32) -> bool {
  if ((flags.x & ${MESH_FLAG_HIGHLIGHTED_ENTITIES}u) != 0u && !entityHighlighted(id)) { return false; }
  if ((flags.x & ${MESH_FLAG_ONE_ENTITY}u) != 0u && id != flags.w) { return false; }
  return true;
}
`;
