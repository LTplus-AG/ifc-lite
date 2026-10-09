/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Carry an element's Pset / Qto / classification / material / type
 * relationships from a source IfcProduct onto one or more target
 * products. Used when an authoring operation produces siblings of
 * a source entity (split, duplicate, etc.) — both halves of a split
 * wall should keep the source's FireRating, etc.
 *
 * Strategy: append the target id(s) to each relationship's
 * `RelatedObjects` list rather than cloning the relationship entity
 * itself. Cheaper, less overlay growth, and the IFC schema allows
 * many objects to share a single rel. Downstream tooling (IDS, Pset
 * dumps, exports) reads each rel's RelatedObjects list, so the
 * targets become first-class members.
 *
 * The relationships we touch:
 *
 *   IfcRelDefinesByProperties   — Psets / Qtos (the big one)
 *   IfcRelDefinesByType         — occurrence → type binding
 *   IfcRelAssociatesClassification
 *   IfcRelAssociatesMaterial
 *   IfcRelContainedInSpatialStructure — storey containment
 *   IfcRelAggregates / IfcRelNests    — element assemblies
 *
 * Containment is handled separately by callers that already use
 * `addWallToStore` / `addSlabToStore` etc. (those builders emit a
 * fresh `IfcRelContainedInSpatialStructure` for the new entity), so
 * this helper deliberately skips it.
 *
 * Returns the number of relationships touched so callers can log
 * useful telemetry. Returns 0 silently when the source has no
 * relationships — that's a valid case.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds, type IfcAttributeValue, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { readAttributes } from './placement-core.js';
import { asRef, refList } from '../style-entity-reader.js';
import { cloneEffectiveMetadata } from './metadata-clone-effective.js';
import { refToken } from '../copy-frame.js';

/** Relationship entity types we touch (case follows STEP storage form). */
const RELATIONSHIPS_TO_CLONE = [
  // [type, related-objects-attribute-index, related-object-is-list-of-refs?]
  ['IFCRELDEFINESBYPROPERTIES', 4],
  ['IFCRELDEFINESBYTYPE', 4],
  ['IFCRELASSOCIATESCLASSIFICATION', 4],
  ['IFCRELASSOCIATESMATERIAL', 4],
  ['IFCRELAGGREGATES', 5],
  ['IFCRELNESTS', 5],
] as const;

export interface CloneMetadataResult {
  /** Number of relationships that gained at least one target. */
  relationshipsTouched: number;
}

/** These schema-known relationship slots are lists of entity references.
 * Parsed numeric IDs must become explicit reference tokens for overlay writes;
 * retaining numeric literals would disconnect every member on STEP export. */
function appendTargetsToList(raw: unknown, targets: number[]): IfcAttributeValue[] {
  return [...refList(raw), ...targets].map(refToken);
}

export function cloneElementMetadata(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  sourceExpressId: number,
  targetExpressIds: number[],
): CloneMetadataResult {
  if (targetExpressIds.length === 0) return { relationshipsTouched: 0 };

  // Dedupe caller-side input so a target listed twice doesn't
  // produce two appends. The per-rel `currentRelated.includes`
  // guard below would catch it on the second pass, but on the
  // first pass both copies would land in the new list.
  const uniqueTargets = Array.from(new Set(targetExpressIds));
  const notSharedProperties = new Set<string>(), notSharedQuantities = new Set<string>();
  if (view.hasChanges(sourceExpressId)) for (const change of view.getEffectiveChanges()) {
    if (change.entityId !== sourceExpressId || change.setName === undefined) continue;
    if (change.kind === 'pset-deleted') notSharedProperties.add(change.setName);
    if (change.kind === 'qset-deleted') notSharedQuantities.add(change.setName);
    // Edited source values are copied through the effective mutation view
    // below, not by sharing their stale source definition.
    if (change.kind === 'property') notSharedProperties.add(change.setName);
    if (change.kind === 'quantity') notSharedQuantities.add(change.setName);
  }
  const propertyNames = new Map<number, Set<string>>(), quantityNames = new Map<number, Set<string>>();
  const namesFor = (id: number, quantity: boolean): Set<string> => {
    const cache = quantity ? quantityNames : propertyNames;
    let names = cache.get(id);
    if (!names) {
      const sets = quantity
        ? view.getQuantitiesForEntity(id)
        : view.getForEntity(id);
      names = new Set(sets.map(set => set.name));
      cache.set(id, names);
    }
    return names;
  };

  let touched = 0;
  for (const [type, index] of RELATIONSHIPS_TO_CLONE) {
    for (const { expressId: relId } of iterateEffectiveEntityIds(dataStore, view, [type])) {
      const attrs = readAttributes(dataStore, view, editor, relId);
      if (!attrs) continue;
      const currentRelated = refList(attrs[index]);
      if (!currentRelated.includes(sourceExpressId)) continue;
      // Skip targets that are already in the list — avoids duplicates
      // when this is called twice for the same operation (idempotent).
      const definitionId = type === 'IFCRELDEFINESBYPROPERTIES' ? asRef(attrs[5]) : null;
      const definitionType = definitionId === null ? null : editor.getEntityType(definitionId)?.toUpperCase();
      const namedSet = definitionType === 'IFCPROPERTYSET' || definitionType === 'IFCELEMENTQUANTITY';
      const readName = namedSet && definitionId !== null ? readAttributes(dataStore, view, editor, definitionId)?.[2] : null;
      const definitionName = typeof readName === 'string' ? readName : null;
      // Logical set deletion is applied during STEP export rather than by
      // editing the source relationship. Sharing that raw membership would
      // restore the deleted set on the new piece.
      if (definitionName !== null && (definitionType === 'IFCELEMENTQUANTITY'
        ? notSharedQuantities : notSharedProperties).has(definitionName)) continue;
      // A builder may already have authored canonical metadata for this piece.
      // Retain that same-name set (especially its newly measured quantities),
      // and share only distinct imported sets. The source itself is untouched.
      const names = definitionName !== null
        ? (id: number) => namesFor(id, definitionType === 'IFCELEMENTQUANTITY') : null;
      const additions = uniqueTargets.filter(id => {
        if (currentRelated.includes(id)) return false;
        return names === null || definitionName === null || !names(id).has(definitionName);
      });
      if (additions.length === 0) continue;
      const newList = appendTargetsToList(attrs[index], additions);
      editor.setPositionalAttribute(relId, index, newList);
      if (names && definitionName !== null) for (const id of additions) names(id).add(definitionName);
      touched++;
    }
  }
  cloneEffectiveMetadata(view, editor, sourceExpressId, uniqueTargets);
  return { relationshipsTouched: touched };
}
