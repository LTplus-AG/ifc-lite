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
import type { IfcAttributeValue, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { asExpressIdRef, readAttributes } from './placement-core.js';

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

/**
 * Coerce a raw RelatedObjects attribute into an array of express ids.
 * Overlay-stored refs are `#X` strings; parsed source refs are bare
 * numbers (see `asExpressIdRef`).
 */
function relatedObjectIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids: number[] = [];
  for (const v of raw) {
    const id = asExpressIdRef(v);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/**
 * Append target ids to the raw RelatedObjects list while preserving
 * the source's ref form (`#X` strings if any source ref is a string,
 * raw numbers otherwise). Avoids accidentally normalising overlay
 * refs into bare numbers, which the exporter wouldn't recognise.
 */
function appendTargetsToList(
  raw: unknown,
  targets: number[],
): unknown[] {
  const list: unknown[] = Array.isArray(raw) ? raw.slice() : [];
  const usesStrings = list.some((v) => typeof v === 'string');
  for (const t of targets) {
    list.push(usesStrings ? `#${t}` : t);
  }
  return list;
}

export function cloneElementMetadata(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: StoreEditor,
  sourceExpressId: number,
  targetExpressIds: number[],
): CloneMetadataResult {
  if (targetExpressIds.length === 0) return { relationshipsTouched: 0 };

  let touched = 0;
  for (const [type, index] of RELATIONSHIPS_TO_CLONE) {
    const relIds = dataStore.entityIndex.byType.get(type) ?? [];
    for (const relId of relIds) {
      const attrs = readAttributes(dataStore, view, editor, relId);
      if (!attrs) continue;
      const currentRelated = relatedObjectIds(attrs[index]);
      if (!currentRelated.includes(sourceExpressId)) continue;
      // Skip targets that are already in the list — avoids duplicates
      // when this is called twice for the same operation (idempotent).
      const additions = targetExpressIds.filter((t) => !currentRelated.includes(t));
      if (additions.length === 0) continue;
      const newList = appendTargetsToList(attrs[index], additions);
      editor.setPositionalAttribute(relId, index, newList as IfcAttributeValue);
      touched++;
    }
  }
  return { relationshipsTouched: touched };
}
