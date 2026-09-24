/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Spatial children (aggregation / containment) of the session's EFFECTIVE
 * model, for the in-store authoring walks (#5249).
 *
 * `extractWallSegmentsForStorey` and `existingSpaceFootprintsByStorey` index
 * `IfcRelAggregates` / `IfcRelContainedInSpatialStructure` by their relating
 * element. That index was built from the parsed type buckets only. So:
 *   - a wall deleted this session was still a room divider;
 *   - a space baked in an earlier Space Sketch run (overlay-created, together
 *     with its containment relationship) was not an "existing space", so
 *     baking again produced a duplicate room on top of it.
 *
 * Relationships now come from the shared effective-entity iterator and are
 * read through `readEntity`, which answers source bytes or an overlay-created
 * payload alike. A deleted child is dropped.
 */

import { iterateEffectiveEntities, type EffectiveEntityOverlay } from '@ifc-lite/data';
import type { EntityExtractor, IfcDataStore } from '@ifc-lite/parser';
import { numericAttr, readEntity, type OverlayWallReader } from './placement-frame.js';

/** The overlay reader as the shared iterator's structural overlay. */
function asEffectiveOverlay(overlay: OverlayWallReader | undefined): EffectiveEntityOverlay | null {
  if (!overlay) return null;
  return {
    isDeleted: (id) => overlay.isDeleted?.(id) ?? false,
    getNewEntities: () => Array.from(overlay.getNewEntities()),
    getTypeMutations: overlay.getTypeMutations ? () => overlay.getTypeMutations!() : undefined,
  };
}

/**
 * Index every effective relationship of `relType` by its relating attribute,
 * so "what is anchored to id X" is O(1) instead of an O(R) scan per parent.
 */
export function buildRelatingChildrenIndex(
  store: IfcDataStore,
  extractor: EntityExtractor,
  overlay: OverlayWallReader | undefined,
  relType: string,
  relatingIdx: number,
  relatedIdx: number,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const { expressId: relId } of iterateEffectiveEntities(store, asEffectiveOverlay(overlay), [relType])) {
    const rel = readEntity(store, extractor, overlay, relId);
    if (!rel) continue;
    const relating = numericAttr(rel.attributes[relatingIdx]);
    if (relating === null) continue;
    const related = rel.attributes[relatedIdx];
    if (!Array.isArray(related)) continue;
    let bucket = out.get(relating);
    if (!bucket) {
      bucket = [];
      out.set(relating, bucket);
    }
    for (const member of related) {
      const child = numericAttr(member);
      if (child !== null && !overlay?.isDeleted?.(child)) bucket.push(child);
    }
  }
  return out;
}

/**
 * The effective class of a spatial child: its retype, else an overlay-created
 * entity's authored class, else the parsed table's. `null` when deleted.
 */
export function effectiveMemberType(
  store: IfcDataStore,
  overlay: OverlayWallReader | undefined,
  id: number,
): string | null {
  if (overlay?.isDeleted?.(id)) return null;
  const retype = overlay?.getTypeMutations?.().get(id)?.newType;
  if (retype) return retype;
  if (overlay) {
    for (const entity of overlay.getNewEntities()) if (entity.expressId === id) return entity.type;
  }
  return store.entities.getTypeName(id) || null;
}

/** Whether `id` is an overlay-created entity (no source bytes to read). */
export function isOverlayCreated(overlay: OverlayWallReader | undefined, id: number): boolean {
  if (!overlay) return false;
  for (const entity of overlay.getNewEntities()) if (entity.expressId === id) return true;
  return false;
}
