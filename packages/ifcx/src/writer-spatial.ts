/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnumToString, type EntityTable, type IfcTypeEnum } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcxExportData } from './writer.js';

function isSpatialRelationship(type: string | undefined): boolean {
  const upper = type?.toUpperCase();
  return upper === 'IFCRELAGGREGATES' || upper === 'IFCRELNESTS'
    || upper === 'IFCRELCONTAINEDINSPATIALSTRUCTURE';
}

export function indexSpatialEdges(
  edges: NonNullable<IfcxExportData['effectiveSpatialEdges']>,
): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const edge of edges) {
    if (!isSpatialRelationship(edge.relationshipType)) continue;
    const targets = children.get(edge.sourceId) ?? [];
    targets.push(edge.targetId);
    children.set(edge.sourceId, targets);
  }
  return children;
}

/** Parsed hierarchy has no relationship ids or editable endpoints. Fail
 *  visibly when it cannot describe the effective session. */
export function hasSpatialRelationshipEdits(entities: EntityTable, view: MutablePropertyView): boolean {
  // The public input also accepts older property-only view adapters; they
  // have no structural edits to inspect (writerEntities uses the same gate).
  if (typeof view.getNewEntities !== 'function' || typeof view.getTombstones !== 'function') return false;
  const sourceSpatialTypes = new Map<number, string>();
  // @raw-entity-enumeration-ok source class lookup detects edited source relationships before writing effective rows
  for (let row = 0; row < entities.count; row++) {
    const id = entities.expressId[row];
    const type = entities.getTypeName?.(id)
      ?? IfcTypeEnumToString(entities.typeEnum[row] as IfcTypeEnum);
    if (isSpatialRelationship(type)) sourceSpatialTypes.set(id, type);
  }
  for (const entity of view.getNewEntities()) {
    if (isSpatialRelationship(entity.type)) return true;
  }
  for (const id of view.getTombstones()) {
    if (sourceSpatialTypes.has(id)) return true;
  }
  for (const [id, change] of view.getTypeMutations()) {
    if (sourceSpatialTypes.has(id) || isSpatialRelationship(change.newType)) return true;
  }
  for (const id of view.getAttributeMutationsByEntity().keys()) {
    if (sourceSpatialTypes.has(id)) return true;
  }
  for (const id of sourceSpatialTypes.keys()) {
    if (view.getPositionalMutationsForEntity(id)?.size) return true;
  }
  return false;
}
