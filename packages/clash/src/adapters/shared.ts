/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Format-independent logic shared by `adapters/step.ts` and `adapters/ifcx.ts`.
 *
 * Both adapters turn a source-specific representation into `ClashElement`s,
 * and both need the SAME two things done to get there correctly:
 *
 * 1. Drop non-physical / container classes before they become clash
 *    candidates (openings, spaces, grids, materials, type objects, and
 *    spatial containers whose geometry encloses — rather than physically
 *    touches — what it contains). (#1464 and its follow-up.)
 * 2. Coalesce every mesh belonging to one durable entity into exactly ONE
 *    `ClashElement`, so an entity with multiple representations (e.g.
 *    Body + Axis) never aliases into several clash candidates that share
 *    one identity.
 *
 * Both are expressed purely in terms of IFC class names / merged geometry
 * buffers — nothing here is STEP- or IFCX-specific. `elementsFromIfcx`'s
 * `tag` is the real IFC class code (`bsi::ifc::class`) or the resolved
 * entity-table type name, so it is spelled identically to `node.type` on the
 * STEP side (`IfcWall`, `IfcSpace`, `IfcOpeningElement`, ...) — verified by
 * `ifcx.ts`'s `resolveTag`. There is nothing format-specific to branch on, so
 * this lives in ONE place both adapters call instead of two copies that can
 * (and did) drift apart.
 *
 * `isSpatialContainerTag` needs `@ifc-lite/parser`'s schema-union inheritance
 * walk to catch IFC4.3 leaves (IfcRoad, IfcBridge, ...) that are not in any
 * hand-maintained list — the exact gap the original #1464 follow-up closed
 * for STEP. `@ifc-lite/parser` is already a full dependency of
 * `@ifc-lite/clash` (see package.json), so importing it here does not add a
 * new package to the graph; it only makes explicit, in the file that needs
 * it, a dependency the package already carries. `elementsFromIfcx`'s own
 * module doc describes the CORE clash engine as representation- and
 * parser-neutral — that claim is about `engine.ts`/`types.ts`, not about this
 * filtering utility, which is allowed to lean on the schema registry both
 * formats already agree on.
 */

import { getInheritanceChainAcrossSchemas, isIfcTypeLikeEntity } from '@ifc-lite/parser';

/**
 * Types that are never physical clash candidates: voids, virtual/reference
 * geometry, and non-product material associations. Including them produced
 * phantom clashes (IfcVirtualElement, IfcOpeningElement, even
 * IfcMaterialConstituent) that no clash rule referenced - they are dropped
 * from the candidate set entirely, so "detect all" and per-rule runs only
 * ever consider real building elements. (#1464)
 *
 * Spatial containers are handled separately by {@link isSpatialContainerTag},
 * which derives them from the schema rather than from a list.
 */
export const NON_CLASHABLE_TAGS: ReadonlySet<string> = new Set([
  'IfcOpeningElement',
  'IfcOpeningStandardCase',
  'IfcVirtualElement',
  'IfcGrid',
  'IfcGridAxis',
  'IfcAnnotation',
  'IfcMaterial',
  'IfcMaterialConstituent',
  'IfcMaterialLayer',
]);

/** Memoizes the schema walk below; IFC type names are a bounded vocabulary. */
const spatialContainerByTag = new Map<string, boolean>();

/**
 * True for spatial *containers* - the entities whose geometry describes an
 * extent that, by construction, encloses the elements assigned to it. A
 * storey against the slab it contains is not a coordination problem, and
 * IFC4.3 infrastructure exports routinely give IfcBuildingStorey / IfcRoad /
 * IfcBridge tessellated bodies, so every contained element clashed with its
 * own container. (follow-up to #1464)
 *
 * Derived from the schema, not enumerated: `getInheritanceChainAcrossSchemas`
 * walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so the IFC4.3 facility
 * leaves (IfcRoad, IfcBridge, IfcFacilityPart, ...) resolve even though the
 * parser's own codegen pin is IFC4_ADD2_TC1 and would return an empty chain
 * for them. Both supertypes are checked because IFC2X3 has no
 * `IfcSpatialElement` - `IfcSpatialStructureElement` descends straight from
 * `IfcProduct` there. This subsumes the IfcSpace / IfcSpatialZone entries
 * that #1464 listed by hand.
 */
export function isSpatialContainerTag(tag: string): boolean {
  const cached = spatialContainerByTag.get(tag);
  if (cached !== undefined) return cached;
  const chain = getInheritanceChainAcrossSchemas(tag);
  const spatial = chain.some(
    (a) => a === 'IfcSpatialElement' || a === 'IfcSpatialStructureElement',
  );
  spatialContainerByTag.set(tag, spatial);
  return spatial;
}

/**
 * Whether an element carrying this IFC class `tag` should never become a
 * clash candidate: non-physical/reference geometry, a spatial container, or
 * a type/style object (a template, not an occurrence — see `step.ts`'s
 * original comment on `isIfcTypeLikeEntity` for why type geometry sails
 * through the mesher and lands on top of the occurrences that use it).
 */
export function isNonClashableTag(tag: string): boolean {
  return (
    NON_CLASHABLE_TAGS.has(tag) ||
    isSpatialContainerTag(tag) ||
    isIfcTypeLikeEntity(tag.toUpperCase())
  );
}

/** A mesh-shaped input to {@link mergeMeshes}: just the two buffers it needs. */
export interface MergeableMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/**
 * Concatenate a group of meshes (all belonging to the same durable entity)
 * into a single position/index buffer, so one entity with several mesh
 * representations (e.g. Body + Axis, or several sub-meshes) becomes exactly
 * ONE `ClashElement` instead of several aliasing elements that share a
 * key/ref. Each subsequent mesh's indices are offset by the running vertex
 * count so the merged index buffer addresses the combined vertex array.
 * Bounds are then derived from the MERGED positions by the caller
 * (`fromPositions` already scans the whole buffer), so the union is correct
 * for free — there is no separate "combine bounds" step to get wrong.
 *
 * A single mesh is returned as-is (no copy) for the common case.
 */
export function mergeMeshes(group: MergeableMesh[]): { positions: Float32Array; indices: Uint32Array } {
  if (group.length === 1) {
    return { positions: group[0].positions, indices: group[0].indices };
  }

  let totalPositions = 0;
  let totalIndices = 0;
  for (const mesh of group) {
    totalPositions += mesh.positions.length;
    totalIndices += mesh.indices.length;
  }

  const positions = new Float32Array(totalPositions);
  const indices = new Uint32Array(totalIndices);
  let positionOffset = 0;
  let indexOffset = 0;
  let vertexBase = 0;
  for (const mesh of group) {
    positions.set(mesh.positions, positionOffset);
    for (let i = 0; i < mesh.indices.length; i++) {
      indices[indexOffset + i] = mesh.indices[i] + vertexBase;
    }
    positionOffset += mesh.positions.length;
    indexOffset += mesh.indices.length;
    // 3 floats per vertex; the next mesh's indices start after these vertices.
    vertexBase += mesh.positions.length / 3;
  }

  return { positions, indices };
}
