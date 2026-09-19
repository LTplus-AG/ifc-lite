/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MutablePropertyView, NewEntity } from '@ifc-lite/mutations';
import { getAttributeNamesAcrossSchemas } from '@ifc-lite/parser';

interface QueuedRelation {
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

function refIds(value: unknown): number[] {
  if (typeof value === 'string') {
    const match = /^#(\d+)$/.exec(value.trim());
    if (!match) return [];
    const id = Number(match[1]);
    return Number.isSafeInteger(id) ? [id] : [];
  }
  return Array.isArray(value) ? value.flatMap(refIds) : [];
}

function resolveRelation(entity: NewEntity, view: MutablePropertyView): QueuedRelation | null {
  if (!entity.type.toUpperCase().startsWith('IFCREL')) return null;
  const names = getAttributeNamesAcrossSchemas(entity.type);
  if (names.length === 0) return null;
  const attributes = [...entity.attributes];
  for (const [index, value] of view.getPositionalMutationsForEntity(entity.expressId) ?? []) attributes[index] = value;
  let relating: number | undefined;
  let related: number[] | undefined;
  for (let index = 0; index < names.length; index++) {
    if (names[index].startsWith('Related')) related ??= refIds(attributes[index]);
    else if (names[index].startsWith('Relating')) relating ??= refIds(attributes[index])[0];
  }
  if (relating === undefined || !related?.length) return null;
  return { relationshipId: entity.expressId, relationshipType: entity.type, relating, related };
}

function queuedRelations(view: MutablePropertyView, relationshipType?: string): QueuedRelation[] {
  const upper = relationshipType?.toUpperCase();
  return view.getNewEntities().flatMap((entity) => {
    const relation = resolveRelation(entity, view);
    return relation && (!upper || relation.relationshipType.toUpperCase() === upper) ? [relation] : [];
  });
}

export function foldMutationRelationshipEdges(view: MutablePropertyView, expressId: number): QueuedRelationshipEdge[] {
  const out: QueuedRelationshipEdge[] = [];
  for (const relation of queuedRelations(view)) {
    if (view.isDeleted(relation.relationshipId)) continue;
    if (relation.relating === expressId) {
      for (const targetId of relation.related) if (!view.isDeleted(targetId)) out.push({
        relationshipId: relation.relationshipId,
        relationshipType: relation.relationshipType,
        direction: 'forward',
        targetId,
      });
    }
    if (relation.related.includes(expressId) && !view.isDeleted(relation.relating)) out.push({
      relationshipId: relation.relationshipId,
      relationshipType: relation.relationshipType,
      direction: 'inverse',
      targetId: relation.relating,
    });
  }
  return out;
}

export function foldMutationRelated(
  view: MutablePropertyView,
  relationshipType: string,
  direction: 'forward' | 'inverse',
  expressId: number,
): number[] {
  const out: number[] = [];
  for (const relation of queuedRelations(view, relationshipType)) {
    if (view.isDeleted(relation.relationshipId)) continue;
    if (direction === 'forward' && relation.relating === expressId) {
      for (const target of relation.related) if (!view.isDeleted(target)) out.push(target);
    } else if (direction === 'inverse' && relation.related.includes(expressId) && !view.isDeleted(relation.relating)) {
      out.push(relation.relating);
    }
  }
  return out;
}
