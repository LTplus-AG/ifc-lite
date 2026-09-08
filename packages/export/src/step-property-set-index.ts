/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The reverse index the property-set/quantity-set collection phase
 * (`step-property-set-collection.ts`) pre-computes over
 * IfcRelDefinesByProperties, so the per-entity "find owning rels" step is
 * O(K) rather than O(N) per modified entity. Split out of
 * `step-property-sets.ts` (#3184).
 */

import type { PropertySetContext } from './step-property-set-readers.js';
import { entityLineText } from './step-property-set-readers.js';

/**
 * Build a one-shot reverse index of every IfcRelDefinesByProperties in
 * the source: for each related entity, list the rels and property/quantity
 * sets that reference it. Used by the export pre-pass so the per-entity
 * "find owning rels" step is O(K) rather than O(N) per modified entity.
 *
 * `relatedByRel` is the same walk read the other way round, so the deleted-host
 * sweep costs nothing extra.
 */
export function buildRelDefinesByPropertiesIndex(ctx: PropertySetContext): {
  byEntity: Map<number, Array<{ relId: number; psetId: number }>>;
  relatedByRel: Map<number, number[]>;
} {
  const byEntity = new Map<number, Array<{ relId: number; psetId: number }>>();
  const relatedByRel = new Map<number, number[]>();
  for (const [relId, relRef] of ctx.dataStore.entityIndex.byId) {
    if (relRef.type.toUpperCase() !== 'IFCRELDEFINESBYPROPERTIES') continue;
    const psetId = getRelatedPropertySet(ctx, relId);
    if (!psetId) continue;
    const related = getRelatedEntities(ctx, relId);
    relatedByRel.set(relId, related);
    for (const entityId of related) {
      let bucket = byEntity.get(entityId);
      if (!bucket) {
        bucket = [];
        byEntity.set(entityId, bucket);
      }
      bucket.push({ relId, psetId });
    }
  }
  return { byEntity, relatedByRel };
}

/**
 * Get entity IDs related by IfcRelDefinesByProperties (the related objects)
 */
function getRelatedEntities(ctx: PropertySetContext, relId: number): number[] {
  const entityText = entityLineText(ctx, relId);
  if (entityText === null) return [];

  // Parse IfcRelDefinesByProperties: #ID=IFCRELDEFINESBYPROPERTIES('guid',$,$,$,(#objects),#pset);
  // The 5th argument (index 4) is the list of related objects
  const match = entityText.match(/\(([^)]+)\)\s*,\s*#(\d+)\s*\)\s*;/);
  if (!match) return [];

  const objectsList = match[1];
  const refs: number[] = [];
  const refMatches = objectsList.matchAll(/#(\d+)/g);
  for (const m of refMatches) {
    refs.push(parseInt(m[1], 10));
  }
  return refs;
}

/**
 * Get the property set ID from IfcRelDefinesByProperties
 */
function getRelatedPropertySet(ctx: PropertySetContext, relId: number): number | null {
  const entityText = entityLineText(ctx, relId);
  if (entityText === null) return null;

  // Last #ID before the closing );
  const match = entityText.match(/,\s*#(\d+)\s*\)\s*;$/);
  if (!match) return null;
  return parseInt(match[1], 10);
}
