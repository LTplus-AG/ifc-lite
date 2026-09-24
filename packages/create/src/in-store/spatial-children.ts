/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial children (aggregation / containment) and storeys of the session's
 * EFFECTIVE model, for the in-store authoring walks (#5249).
 *
 * `extractWallSegmentsForStorey` and `existingSpaceFootprintsByStorey` index
 * `IfcRelAggregates` / `IfcRelContainedInSpatialStructure` by their relating
 * element. That index was built from the parsed type buckets only. So:
 *   - a wall deleted this session was still a room divider;
 *   - a space baked in an earlier Space Sketch run (overlay-created, together
 *     with its containment relationship) was not an "existing space", so
 *     baking again produced a duplicate room on top of it.
 *
 * Relationships and storeys now come from the shared effective-entity
 * iterator. Relationships are read through `readEntity` (source bytes or an
 * overlay-created payload) with queued positional edits applied, and a deleted
 * child is dropped.
 *
 * {@link OverlayLookup} snapshots the overlay ONCE per walk: the view copies
 * `getNewEntities()` / `getTypeMutations()` on every call, so resolving each
 * member through them would be O(members x created entities) per index build.
 */

import { iterateEffectiveEntities, type EffectiveEntityOverlay } from '@ifc-lite/data';
import type { EntityExtractor, IfcAttributeValue, IfcDataStore } from '@ifc-lite/parser';
import { numericAttr, readEntity, type OverlayWallReader } from './placement-frame.js';

/** The overlay, snapshotted once for one walk. */
export interface OverlayLookup {
  readonly overlay: OverlayWallReader | undefined;
  readonly iteratorOverlay: EffectiveEntityOverlay | null;
  isDeleted(id: number): boolean;
  /** Authored class of an overlay-created entity, else `undefined`. */
  createdType(id: number): string | undefined;
  /** Queued retype, else `undefined`. */
  retypeOf(id: number): string | undefined;
}

export function createOverlayLookup(overlay: OverlayWallReader | undefined): OverlayLookup {
  if (!overlay) {
    return {
      overlay,
      iteratorOverlay: null,
      isDeleted: () => false,
      createdType: () => undefined,
      retypeOf: () => undefined,
    };
  }
  const created = Array.from(overlay.getNewEntities());
  const createdTypes = new Map(created.map((e) => [e.expressId, e.type]));
  const retypes = overlay.getTypeMutations?.() ?? new Map<number, { readonly newType: string }>();
  const isDeleted = (id: number) => overlay.isDeleted?.(id) ?? false;
  return {
    overlay,
    iteratorOverlay: { isDeleted, getNewEntities: () => created, getTypeMutations: () => retypes },
    isDeleted,
    createdType: (id) => createdTypes.get(id),
    retypeOf: (id) => retypes.get(id)?.newType,
  };
}

/** One relationship attribute with a queued positional edit applied. */
function effectiveAttr(
  overlay: OverlayWallReader | undefined,
  id: number,
  attributes: readonly IfcAttributeValue[],
  index: number,
): IfcAttributeValue | undefined {
  const edited = overlay?.getPositionalMutationsForEntity?.(id)?.get(index);
  return edited !== undefined ? edited : attributes[index];
}

/**
 * Index every effective relationship of `relType` by its relating attribute,
 * so "what is anchored to id X" is O(1) instead of an O(R) scan per parent.
 */
export function buildRelatingChildrenIndex(
  store: IfcDataStore,
  extractor: EntityExtractor,
  lookup: OverlayLookup,
  relType: string,
  relatingIdx: number,
  relatedIdx: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const { overlay } = lookup;
  for (const { expressId: relId } of iterateEffectiveEntities(store, lookup.iteratorOverlay, [relType])) {
    const rel = readEntity(store, extractor, overlay, relId);
    if (!rel) continue;
    const relating = numericAttr(effectiveAttr(overlay, relId, rel.attributes, relatingIdx));
    if (relating === null) continue;
    const related = effectiveAttr(overlay, relId, rel.attributes, relatedIdx);
    if (!Array.isArray(related)) continue;
    let bucket = out.get(relating);
    if (!bucket) {
      bucket = [];
      out.set(relating, bucket);
    }
    for (const member of related) {
      const child = numericAttr(member);
      if (child !== null && !lookup.isDeleted(child)) bucket.push(child);
    }
  }
  return out;
}

/**
 * The effective class of an entity: its retype, else an overlay-created
 * entity's authored class, else the parsed table's. `null` when deleted.
 */
export function effectiveMemberType(store: IfcDataStore, lookup: OverlayLookup, id: number): string | null {
  if (lookup.isDeleted(id)) return null;
  return lookup.retypeOf(id) ?? lookup.createdType(id) ?? (store.entities.getTypeName(id) || null);
}

/** Every storey of the effective model, in iterator order. */
export function effectiveStoreyIds(store: IfcDataStore, lookup: OverlayLookup): number[] {
  return Array.from(iterateEffectiveEntities(store, lookup.iteratorOverlay, ['IFCBUILDINGSTOREY']), (e) => e.expressId);
}
