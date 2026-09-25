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

import { resolveEffectiveEntityRecord } from '@ifc-lite/parser';
import { authoredEntityRefs, type EffectiveEntityIndex } from './effective-index.js';
import type { PropertySetContext } from './step-property-set-readers.js';
import { entityLineText } from './step-property-set-readers.js';

/**
 * Build a one-shot reverse index of every effective IfcRelDefinesByProperties:
 * for each related entity, list the rels and property/quantity
 * sets that reference it. Used by the export pre-pass so the per-entity
 * "find owning rels" step is O(K) rather than O(N) per modified entity.
 *
 * `relatedByRel` is the same walk read the other way round, so the deleted-host
 * sweep costs nothing extra.
 */
export function buildRelDefinesByPropertiesIndex(ctx: PropertySetContext, effective: EffectiveEntityIndex): {
  byEntity: Map<number, Array<{ relId: number; psetId: number }>>;
  relatedByRel: Map<number, number[]>;
} {
  const byEntity = new Map<number, Array<{ relId: number; psetId: number }>>();
  const relatedByRel = new Map<number, number[]>();
  for (const relId of effective.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
    const edited = effective.isOverlayCreated(relId) || effective.hasSourceMutation?.(relId);
    const relation = edited ? effectiveRelation(ctx, effective, relId) : null;
    const psetId = edited ? relation?.psetId : getRelatedPropertySet(ctx, relId);
    if (!psetId) continue;
    const related = edited ? relation?.related ?? [] : getRelatedEntities(ctx, relId);
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

/** Read the relationship as the exporter will write it, including post-create
 * edits and source-backed reference retargets. */
function effectiveRelation(
  ctx: PropertySetContext,
  effective: EffectiveEntityIndex,
  relId: number,
): { psetId: number | undefined; related: number[] } | null {
  const view = ctx.mutationView;
  if (!view) return null;
  const created = effective.isOverlayCreated(relId) ? view.getNewEntity(relId) : null;
  // @raw-entity-enumeration-ok point lookup for source attributes; authored relations are read from the overlay above
  const sourceRef = created ? null : ctx.dataStore.entityIndex.byId.get(relId);
  const source = sourceRef && ctx.entityExtractor?.extractEntity(sourceRef);
  const entity = created ?? source;
  if (!entity) return null;
  const record = resolveEffectiveEntityRecord(
    { type: entity.type, attributes: entity.attributes },
    {
      retype: view.getEntityTypeMutation(relId)?.newType,
      named: view.getAttributeMutationsForEntity(relId).map(({ name, value }) => [name, value] as const),
      positional: view.getPositionalMutationsForEntity(relId) ?? [],
    },
    ctx.dataStore.schemaVersion,
  );
  const relatedSlot = record.names.indexOf('RelatedObjects');
  const psetSlot = record.names.indexOf('RelatingPropertyDefinition');
  if (relatedSlot < 0 || psetSlot < 0) return null;
  return {
    related: recordRefs(record.attributes[relatedSlot]),
    psetId: recordRefs(record.attributes[psetSlot])[0],
  };
}

/** Extractor values are numeric ids; authored and mutated values use `#id`. */
function recordRefs(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(recordRefs);
  return typeof value === 'string' ? authoredEntityRefs(value) : [];
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
