/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, expandTypeNamesToDescendants, IFC_ENTITY_NAMES, RelationshipType } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { effectiveMutationRelationships } from '@/sdk/adapters/query-overlay-relations.js';
import { effectiveTreeType } from './treeOverlay.js';

export interface EffectiveTypeEntity {
  expressId: number;
  typeClassName: string;
  name: string;
}

/** A source or authored entity's Name after live attribute edits. */
export function effectiveTreeEntityName(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
  expressId: number,
): string {
  const authoredName = view?.getNewEntity(expressId)?.attributes[2] ?? store.entities.getName(expressId);
  const editedName = view?.getAttributeMutationsForEntity(expressId)
    .find((mutation) => mutation.name === 'Name')?.value;
  const positionalName = view?.getPositionalMutationsForEntity(expressId)?.get(2);
  const effectiveName = positionalName !== undefined ? positionalName
    : editedName !== undefined ? editedName : authoredName;
  return typeof effectiveName === 'string' && effectiveName.length > 0
    ? effectiveName : `#${expressId}`;
}

/** Type rows in the edited model, including types created after parsing (#5249). */
export function* effectiveTypeEntities(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): IterableIterator<EffectiveTypeEntity> {
  const types = expandTypeNamesToDescendants(['IfcTypeObject'], store.schemaVersion);
  function* sourceIds(): IterableIterator<number> {
    // @raw-entity-enumeration-ok source table supplies the type iterator's row domain; the shared accessor applies deletes, retypes and creations
    for (let i = 0; i < store.entities.count; i++) yield store.entities.expressId[i];
  }

  for (const entity of iterateEffectiveEntityIds(store, view, types, sourceIds())) {
    const typeClassName = IFC_ENTITY_NAMES[entity.type] ?? entity.type;
    yield { expressId: entity.expressId, typeClassName,
      name: effectiveTreeEntityName(store, view, entity.expressId) };
  }
}

interface TypeAssignments {
  byType: Map<number, number[]>;
  rewrittenRelationIds: ReadonlySet<number>;
}

/** Authored and rewritten type bindings, indexed once per tree build. */
export function effectiveTypeAssignments(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): TypeAssignments {
  const byType = new Map<number, number[]>();
  if (!view) return { byType, rewrittenRelationIds: new Set() };
  // The shared relationship reader resolves STEP-style named refs (#12),
  // positional edits and schema-specific slots the same way saved IFC does.
  const effective = effectiveMutationRelationships(store, view);
  for (const relation of effective.relationships) {
    if (relation.relationshipType !== 'IfcRelDefinesByType') continue;
    for (const typeId of relation.relating) {
      const bucket = byType.get(typeId) ?? [];
      bucket.push(...relation.related);
      byType.set(typeId, bucket);
    }
  }
  return { byType, rewrittenRelationIds: effective.supersededSourceIds };
}

/** Parsed bindings plus relations authored this session, without dead edges. */
export function effectiveTypeInstanceIds(
  store: IfcDataStore,
  typeId: number,
  view: MutablePropertyView | null | undefined,
  assignments: TypeAssignments,
): number[] {
  const survives = (relationId: number): boolean =>
    !assignments.rewrittenRelationIds.has(relationId)
    && effectiveTreeType(view, relationId, 'IfcRelDefinesByType') === 'IfcRelDefinesByType';
  const ids = new Set<number>();
  for (const edge of store.relationships.forward.getEdges(typeId, RelationshipType.DefinesByType)) {
    if (edgeSurvives(edge, (id) => !survives(id)) && !view?.isDeleted(edge.target)) ids.add(edge.target);
  }
  for (const id of assignments.byType.get(typeId) ?? []) {
    if (!view?.isDeleted(id)) ids.add(id);
  }
  return [...ids];
}
