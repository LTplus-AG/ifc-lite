/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, RelationshipType, type IfcAttributeValue } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations';

export interface EffectiveGroups {
  supersededSourceIds: ReadonlySet<number>;
  byMember: ReadonlyMap<number, readonly number[]>;
}

/** Snapshot edited group relations once per lens evaluation, not once per product. */
export function effectiveGroups(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
): EffectiveGroups | null {
  if (!view?.hasPendingChanges()) return null;
  const overlay = effectiveMutationRelationships(store, view);
  const byMember = new Map<number, number[]>();
  for (const relation of overlay.relationships) {
    if (!relation.relationshipType.toUpperCase().startsWith('IFCRELASSIGNSTOGROUP')) continue;
    for (const member of relation.related) {
      const groups = byMember.get(member) ?? [];
      groups.push(...relation.relating);
      byMember.set(member, groups);
    }
  }
  return { supersededSourceIds: overlay.supersededSourceIds, byMember };
}

export function effectiveGroupIds(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  expressId: number,
  overlay: EffectiveGroups | null,
): number[] {
  if (view?.isDeleted(expressId)) return [];
  const superseded = (id: number) => view?.isDeleted(id) === true
    || overlay?.supersededSourceIds.has(id) === true;
  const result: number[] = [];
  const seen = new Set<number>();
  const take = (id: number) => {
    if (!view?.isDeleted(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  };
  for (const type of [RelationshipType.AssignsToGroup, RelationshipType.AssignsToGroupByFactor]) {
    for (const edge of store.relationships.inverse.getEdges(expressId, type)) {
      if (edgeSurvives(edge, superseded)) take(edge.target);
    }
  }
  for (const id of overlay?.byMember.get(expressId) ?? []) take(id);
  return result;
}

function scalar(value: IfcAttributeValue | undefined): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'typed' in value) {
    return scalar(value.typed.value);
  }
  return undefined;
}

function groupAttribute(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  id: number,
  name: 'Name' | 'ObjectType',
  index: number,
): string | undefined {
  const positional = view?.getPositionalMutationsForEntity(id)?.get(index);
  if (positional !== undefined) return scalar(positional);
  const named = view?.getAttributeMutationsForEntity(id).find((entry) => entry.name === name);
  if (named) return named.value || undefined;
  const authored = view?.getNewEntity(id)?.attributes[index];
  if (authored !== undefined) return scalar(authored);
  const table = name === 'Name' ? store.entities.getName(id) : store.entities.getObjectType(id);
  return table || scalar(store.getEntity(id)?.attributes[index]);
}

export function effectiveGroupRecord(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  id: number,
): { id: number; name?: string; type: string; objectType?: string } {
  return {
    id,
    name: groupAttribute(store, view, id, 'Name', 2),
    type: view?.getEntityTypeMutation(id)?.newType
      || view?.getNewEntity(id)?.type
      || store.entities.getTypeName(id)
      || store.getEntity(id)?.type || 'Unknown',
    objectType: groupAttribute(store, view, id, 'ObjectType', 4),
  };
}
