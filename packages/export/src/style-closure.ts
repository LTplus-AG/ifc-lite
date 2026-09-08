/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Rescue `IFCSTYLEDITEM` / `IFCSTYLEDREPRESENTATION` /
 * `IFCPRESENTATIONLAYERASSIGNMENT` / `IFCPRESENTATIONLAYERWITHSTYLE` into a
 * STEP export closure that otherwise never reaches them.
 *
 * Split out of `reference-collector.ts` (which already sits at its module
 * size budget) rather than grown in place — same reason `georef-closure.ts`
 * was split out: `collectReferencedEntityIds` only walks FORWARD from a
 * product, but a styled item / layer assignment references geometry the
 * OTHER way (item -> style, layer -> assigned item), so nothing reaches it
 * from a product root. This file's `collectStyleEntities` does one reverse
 * pass over the byType index instead: for each candidate, check if any
 * referenced id is already in the closure, and if so rescue it.
 */

import type { IfcSourceBytes } from '@ifc-lite/parser';
import { collectRefsInByteRange } from './reference-collector.js';
import { isGeometryEntity } from './step-geometry-types.js';

/**
 * The four entity classes `collectStyleEntities` rescues. Exported so
 * `step-source-iteration.ts` can apply the SAME dangling-ref-safe line
 * filter (`filterHiddenRefsFromRelationshipLine`) to a rescued entity's own
 * output line as it already does for `IFCREL*` — a rescued
 * `IFCPRESENTATIONLAYERASSIGNMENT` can legitimately end up naming both a
 * kept item and an excluded one (see `collectStyleEntities`'s own doc), and
 * without that filter its `AssignedItems` line would ship a dangling `#N`.
 */
export const STYLE_RESCUE_TYPES: ReadonlySet<string> = new Set([
  'IFCSTYLEDITEM',
  'IFCSTYLEDREPRESENTATION',
  'IFCPRESENTATIONLAYERASSIGNMENT',
  'IFCPRESENTATIONLAYERWITHSTYLE',
]);

/**
 * Presentation RESOURCE types (colours, surface styles, the assignment that
 * glues a style to an item) that `isGeometryEntity` also classifies as
 * "geometry" for the unrelated `includeGeometry: false` feature, but that
 * are never exclusively owned by one product the way an
 * `IfcShapeRepresentation` or `IfcExtrudedAreaSolid` is: they are shared
 * presentation data, referenced BY styled items rather than referencing a
 * product's geometry themselves. `IFCSTYLEDITEM` is deliberately NOT in this
 * set — a `IfcStyledRepresentation.Items` list can itself mix a rescued
 * (visible) styled item with one reachable only through a hidden product's
 * OWN styled item (each product can carry its own styling), so it gets the
 * same "must already be in the closure" treatment as any other geometry
 * candidate.
 */
const STYLE_RESOURCE_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'IFCPRESENTATIONSTYLEASSIGNMENT',
  'IFCSURFACESTYLE',
  'IFCSURFACESTYLERENDERING',
  'IFCCOLOURRGB',
]);

/**
 * Collect style and presentation-layer entities (IFCSTYLEDITEM,
 * IFCSTYLEDREPRESENTATION, IFCPRESENTATIONLAYERASSIGNMENT,
 * IFCPRESENTATIONLAYERWITHSTYLE) that reference geometry already in the
 * closure, then transitively follow their own references.
 *
 * In IFC STEP, IFCSTYLEDITEM references a geometry RepresentationItem, but
 * nothing references the StyledItem back — and IFCPRESENTATIONLAYERASSIGNMENT
 * is the same shape: it names the representation/items assigned to a layer
 * (`AssignedItems`) but nothing points back at the assignment itself. So the
 * forward closure walk misses both entirely. This function does one reverse
 * pass using the byType index: for each candidate, check if any referenced ID
 * is in the closure. If yes, add it and walk its own reference chain in.
 *
 * ## Why the forward walk needs more than `excludeIds`
 *
 * `excludeIds` (`hiddenProductIds`) only ever holds PRODUCT ids, never the
 * geometry those products exclusively own. `IfcPresentationLayerAssignment.
 * AssignedItems` routinely names REPRESENTATION-level ids directly (one CAD
 * layer naming every wall's `IfcShapeRepresentation`), so a shared layer
 * assignment can legitimately be rescued by a VISIBLE wall's representation
 * while also naming a HIDDEN wall's — an id nowhere in `excludeIds`. A plain
 * `excludeIds.has(id)` check (the shape `collectGeoreferencingEntities` uses)
 * would miss that id entirely and resurrect the hidden wall's geometry.
 *
 * The fix relies on an invariant this function's own contract already
 * guarantees: it runs strictly AFTER `collectReferencedEntityIds`, which has
 * already walked the FULL forward closure from every visible root. So any
 * geometry/representation-classified entity (`isGeometryEntity`) that is
 * NOT already in `closure` by the time this pass starts has no other path to
 * visibility — it is either exclusively owned by an excluded product, or
 * genuinely unreferenced by any visible root — and must not be resurrected
 * just because it happens to sit in the same `AssignedItems`/`Item` list as
 * something that IS visible. Presentation RESOURCE types (colours, surface
 * styles — see `STYLE_RESOURCE_EXEMPT_TYPES`) are the one exception: they are
 * shared data, never product-exclusive, so the pre-existing "pull in the
 * style chain" behaviour for them is preserved unconditionally.
 *
 * `excludeIds` is still threaded through and checked directly (matching
 * `collectGeoreferencingEntities`'s shape) as a second, cheap guard — e.g. if
 * a future entity ever names an excluded id that is not geometry-classified.
 *
 * Uses byType for O(candidates) instead of O(allEntities), and byte-level
 * scanning for #ID extraction.
 *
 * Must be called AFTER collectReferencedEntityIds so the closure is complete.
 *
 * @param closure - The existing closure set (mutated in place)
 * @param source - The original STEP file source buffer
 * @param entityIndex - Full entity index with type info and byType lookup
 * @param excludeIds - Entity IDs to never add, even if they reference the
 *   closure (e.g. `pass.hiddenProductIds` / a subset export's `excludedIds`)
 */
export function collectStyleEntities(
  closure: Set<number>,
  source: Uint8Array | IfcSourceBytes,
  entityIndex: {
    byId: {
      get(expressId: number): { type: string; byteOffset: number; byteLength: number } | undefined;
      has(expressId: number): boolean;
      refsOf?(expressId: number): readonly number[] | undefined;
    };
    byType: Map<string, number[]>;
  },
  excludeIds?: ReadonlySet<number>,
): void {
  const queue: number[] = [];
  const refsOf = (expressId: number, ref: { byteOffset: number; byteLength: number }): number[] => {
    const authored = entityIndex.byId.refsOf?.(expressId);
    if (authored) return authored.slice();
    return collectRefsInByteRange(source, ref.byteOffset, ref.byteLength);
  };

  // Use byType index for direct lookup — O(candidates) not O(allEntities)
  const styledItemIds = entityIndex.byType.get('IFCSTYLEDITEM') ?? [];
  const styledRepIds = entityIndex.byType.get('IFCSTYLEDREPRESENTATION') ?? [];
  const layerAssignmentIds = entityIndex.byType.get('IFCPRESENTATIONLAYERASSIGNMENT') ?? [];
  // IFCPRESENTATIONLAYERWITHSTYLE is a subtype (adds LayerOn/LayerFrozen/
  // LayerBlocked/LayerStyles) indexed under its own STEP type name, not
  // IFCPRESENTATIONLAYERASSIGNMENT's — a separate byType lookup, same rescue.
  const layerWithStyleIds = entityIndex.byType.get('IFCPRESENTATIONLAYERWITHSTYLE') ?? [];

  for (const ids of [styledItemIds, styledRepIds, layerAssignmentIds, layerWithStyleIds]) {
    for (const expressId of ids) {
      if (closure.has(expressId)) continue;

      const entityRef = entityIndex.byId.get(expressId);
      if (!entityRef) continue;

      // Check if any referenced ID is in the closure
      const refs = refsOf(expressId, entityRef);

      let referencesClosureEntity = false;
      for (let i = 0; i < refs.length; i++) {
        if (closure.has(refs[i])) {
          referencesClosureEntity = true;
          break;
        }
      }

      if (referencesClosureEntity) {
        closure.add(expressId);
        queue.push(expressId);
      }
    }
  }

  // Walk forward from newly added style entities to pull in their style chain
  // (IfcPresentationStyleAssignment → IfcSurfaceStyle → IfcSurfaceStyleRendering → IfcColourRgb)
  // — but see the function doc for why a geometry-classified id not already
  // in the closure is refused here rather than resurrected.
  while (queue.length > 0) {
    const entityId = queue.pop()!;
    const ref = entityIndex.byId.get(entityId);
    if (!ref) continue;

    const refs = refsOf(entityId, ref);

    for (let i = 0; i < refs.length; i++) {
      const referencedId = refs[i];
      if (closure.has(referencedId)) continue;
      if (excludeIds?.has(referencedId)) continue;

      const targetRef = entityIndex.byId.get(referencedId);
      if (!targetRef) continue;

      const targetType = targetRef.type.toUpperCase();
      if (isGeometryEntity(targetType) && !STYLE_RESOURCE_EXEMPT_TYPES.has(targetType)) {
        // A representation/geometry id this pass has not already proven
        // visible — refusing it is what stops a shared layer assignment or
        // styled representation from resurrecting a hidden product's
        // exclusively-owned geometry (see function doc).
        continue;
      }

      closure.add(referencedId);
      queue.push(referencedId);
    }
  }
}
