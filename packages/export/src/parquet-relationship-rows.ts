/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { flattenRelationshipEdges, relationshipTypeName } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveEffectiveRelationshipOverlay, type IfcDataStore } from '@ifc-lite/parser';
import type { EffectiveEntityIndex } from './effective-index.js';

/** The four columns of the BOS relationship table, one row per relationship edge. */
export function parquetRelationshipRows(
  store: IfcDataStore,
  view: MutablePropertyView | null,
  effective: EffectiveEntityIndex | null,
): { SourceId: number[]; TargetId: number[]; RelType: string[]; RelId: number[] } {
  const rows = { SourceId: [] as number[], TargetId: [] as number[], RelType: [] as string[], RelId: [] as number[] };
  const overlay = view ? resolveEffectiveRelationshipOverlay(store, {
    createdEntities: () => view.getNewEntities(),
    mutatedEntityIds: () => [...new Set([
      ...view.getMutations()
        .filter(mutation => mutation.type === 'UPDATE_POSITIONAL_ATTRIBUTE')
        .map(mutation => mutation.entityId),
      ...view.getTypeMutations().keys(),
      ...view.getAttributeMutationsByEntity().keys(),
    ])].filter(id => !view.isDeleted(id)),
    namedAttributes: id => view.getAttributeMutationsForEntity(id).map(({ name, value }) => [name, value] as const),
    positionalAttributes: id => view.getPositionalMutationsForEntity(id) ?? [],
    entityType: id => view.getEntityTypeMutation(id)?.newType,
    isDeleted: id => view.isDeleted(id),
  }) : null;
  const add = (source: number, target: number, type: string, relation: number): void => {
    if (effective && (effective.isDeleted(source) || effective.isDeleted(target) || effective.isDeleted(relation))) return;
    rows.SourceId.push(source);
    rows.TargetId.push(target);
    rows.RelType.push(type);
    rows.RelId.push(relation);
  };

  // The parsed graph preserves distinct IfcRel records that name the same
  // endpoints. Suppress only records whose effective payload was rebuilt.
  for (const edge of flattenRelationshipEdges(store.relationships.forward)) {
    if (overlay?.supersededSourceIds.has(edge.relationshipId)) continue;
    add(edge.sourceId, edge.targetId, relationshipTypeName(edge.type), edge.relationshipId);
  }
  for (const relation of overlay?.relationships ?? []) {
    for (const source of relation.relating) {
      for (const target of relation.related) {
        add(source, target, relation.relationshipType, relation.relationshipId);
      }
    }
  }
  return rows;
}
