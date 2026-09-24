/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, IFC_ENTITY_NAMES, RelationshipType } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { GroupMember, IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations.js';
import { GROUP_ENTITY_TYPES } from './groupEntityTypes.js';
import { effectiveTreeEntityName } from './effectiveTypeEntities.js';
import { effectiveTreeType } from './treeOverlay.js';

const GROUP_RELATIONS = new Set(['IFCRELASSIGNSTOGROUP', 'IFCRELASSIGNSTOGROUPBYFACTOR']);

function* columnarIds(store: IfcDataStore): IterableIterator<number> {
  // @raw-entity-enumeration-ok the IFCX source table supplies the canonical effective iterator's domain
  for (let i = 0; i < store.entities.count; i++) yield store.entities.expressId[i];
}

/** Source and authored groups, bucketed by their current EXPRESS class. */
export function effectiveGroupIds(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): Map<string, number[]> {
  const byClass = new Map<string, number[]>();
  // @raw-entity-enumeration-ok an empty STEP index identifies an IFCX source domain supplied to the effective iterator
  const sourceIds = store.entityIndex.byType.size === 0 ? columnarIds(store) : undefined;
  for (const entity of iterateEffectiveEntityIds(store, view, GROUP_ENTITY_TYPES, sourceIds)) {
    const type = IFC_ENTITY_NAMES[entity.type] ?? entity.type;
    const bucket = byClass.get(type) ?? [];
    bucket.push(entity.expressId);
    byClass.set(type, bucket);
  }
  return byClass;
}

interface GroupAssignments {
  byGroup: Map<number, number[]>;
  supersededSourceIds: ReadonlySet<number>;
}

/** Created and rewritten IfcRelAssignsToGroup endpoints, indexed once per build. */
export function effectiveGroupAssignments(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): GroupAssignments {
  const byGroup = new Map<number, number[]>();
  if (!view) return { byGroup, supersededSourceIds: new Set() };
  const effective = effectiveMutationRelationships(store, view);
  for (const relation of effective.relationships) {
    if (!GROUP_RELATIONS.has(relation.relationshipType.toUpperCase())) continue;
    for (const groupId of relation.relating) {
      const bucket = byGroup.get(groupId) ?? [];
      bucket.push(...relation.related);
      byGroup.set(groupId, bucket);
    }
  }
  return { byGroup, supersededSourceIds: effective.supersededSourceIds };
}

/** Membership of one group after relationship and entity edits. */
export function effectiveGroupMembers(
  store: IfcDataStore,
  groupId: number,
  view: MutablePropertyView | null | undefined,
  assignments: GroupAssignments,
): GroupMember[] {
  const memberIds = new Set<number>();
  const relationGone = (id: number): boolean =>
    assignments.supersededSourceIds.has(id)
    || !GROUP_RELATIONS.has((effectiveTreeType(view, id, 'IfcRelAssignsToGroup') ?? '').toUpperCase());
  for (const edge of store.relationships.forward.getEdges(groupId, RelationshipType.AssignsToGroup)) {
    if (edgeSurvives(edge, relationGone)) memberIds.add(edge.target);
  }
  for (const id of assignments.byGroup.get(groupId) ?? []) memberIds.add(id);

  const members: GroupMember[] = [];
  for (const id of memberIds) {
    if (view?.isDeleted(id)) continue;
    // @raw-entity-enumeration-ok point lookup of an effective relationship target, with created and deleted entities handled here
    const parsedType = store.entityIndex.byId.get(id)?.type
      ?? store.deferredEntityIndex?.get(id)?.type
      ?? store.entities.getTypeName(id);
    const authoredType = view?.getNewEntity(id)?.type;
    if (!authoredType && (!parsedType || parsedType === 'Unknown')) continue;
    const type = effectiveTreeType(view, id, authoredType ?? parsedType);
    if (!type) continue;
    const name = effectiveTreeEntityName(store, view, id);
    members.push({ id, name: name === `#${id}` ? undefined : name,
      type: IFC_ENTITY_NAMES[type.toUpperCase()] ?? type });
  }
  return members;
}

/** Edited Name, with the Groups tab's ObjectType fallback. */
export function effectiveGroupName(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  id: number,
  type: string,
): string {
  const name = effectiveTreeEntityName(store, view, id);
  if (name !== `#${id}`) return name;
  const objectType = view?.getPositionalMutationsForEntity(id)?.get(4)
    ?? view?.getAttributeMutationsForEntity(id).find(change => change.name === 'ObjectType')?.value
    ?? view?.getNewEntity(id)?.attributes[4]
    ?? store.entities.getObjectType?.(id);
  return typeof objectType === 'string' && objectType ? objectType : `${type} #${id}`;
}
