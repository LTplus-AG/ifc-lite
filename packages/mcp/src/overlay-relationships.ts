/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';
import type { CreatedEntity } from './overlay.js';

/** One queued `IfcRel…` record, resolved to the entities it links. */
export interface QueuedRelation {
  relationshipId: number;
  relationshipType: string;
  relating: number;
  related: readonly number[];
}

export interface QueuedRelationshipEdge {
  relationshipId: number;
  relationshipType: string;
  direction: 'forward' | 'inverse';
  targetId: number;
}

/** Exact graph rows contributed by queued relationship records touching an entity. */
export function queuedRelationshipEdges(
  created: readonly CreatedEntity[],
  deleted: ReadonlySet<number>,
  expressId: number,
): QueuedRelationshipEdge[] {
  const out: QueuedRelationshipEdge[] = [];
  for (const relations of indexQueuedRelations(created).values()) {
    for (const relation of relations) {
      if (deleted.has(relation.relationshipId)) continue;
      if (relation.relating === expressId) {
        for (const targetId of relation.related) if (!deleted.has(targetId)) out.push({
          relationshipId: relation.relationshipId,
          relationshipType: relation.relationshipType,
          direction: 'forward',
          targetId,
        });
      }
      if (relation.related.includes(expressId) && !deleted.has(relation.relating)) out.push({
        relationshipId: relation.relationshipId,
        relationshipType: relation.relationshipType,
        direction: 'inverse',
        targetId: relation.relating,
      });
    }
  }
  return out;
}

/** Group queued relationships by exact IFC class, resolving role attributes by name. */
export function indexQueuedRelations(created: readonly CreatedEntity[]): Map<string, QueuedRelation[]> {
  const byType = new Map<string, QueuedRelation[]>();
  for (const entity of created) {
    const upper = entity.ifcType.toUpperCase();
    if (!upper.startsWith('IFCREL')) continue;
    const names = getAttributeNamesAcrossSchemas(entity.ifcType);
    if (names.length === 0) continue;
    let relating: number | undefined;
    let related: number[] | undefined;
    for (let i = 0; i < names.length; i++) {
      if (names[i].startsWith('Related')) related ??= refIds(entity.attributes[i]);
      else if (names[i].startsWith('Relating')) relating ??= refIds(entity.attributes[i])[0];
    }
    if (relating === undefined || !related?.length) continue;
    const relation = { relationshipId: entity.expressId, relationshipType: entity.ifcType, relating, related };
    const list = byType.get(upper);
    if (list) list.push(relation);
    else byType.set(upper, [relation]);
  }
  return byType;
}

function refIds(value: unknown): number[] {
  if (typeof value === 'string') {
    const match = /^#(\d+)$/.exec(value.trim());
    if (!match) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }
  return Array.isArray(value) ? value.flatMap(refIds) : [];
}
