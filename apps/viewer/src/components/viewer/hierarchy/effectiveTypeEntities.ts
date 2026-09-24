/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { edgeSurvives, expandTypeNamesToDescendants, IFC_ENTITY_NAMES, RelationshipType } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import { resolveEffectiveEntityRecord, type IfcDataStore } from '@ifc-lite/parser';
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
  return (typeof positionalName === 'string' ? positionalName : editedName)
    || (typeof authoredName === 'string' ? authoredName : '') || `#${expressId}`;
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
  rewrittenRelationIds: Set<number>;
}

/** Authored and rewritten type bindings, indexed once per tree build. */
export function effectiveTypeAssignments(
  store: IfcDataStore,
  view: MutablePropertyView | null | undefined,
): TypeAssignments {
  const byType = new Map<number, number[]>();
  const rewrittenRelationIds = new Set<number>();
  const addRelation = (relation: { expressId: number; type: string; attributes: readonly unknown[] }) => {
    if (view?.isDeleted(relation.expressId)) return;
    const record = resolveEffectiveEntityRecord(relation, {
      retype: view?.getEntityTypeMutation(relation.expressId)?.newType,
      named: view?.getAttributeMutationsForEntity(relation.expressId)
        .map(({ name, value }) => [name, value] as const) ?? [],
      positional: view?.getPositionalMutationsForEntity(relation.expressId) ?? [],
    }, store.schemaVersion);
    if (record.type.toUpperCase() !== 'IFCRELDEFINESBYTYPE') return;
    const related = record.attributes[4];
    const typeId = record.attributes[5];
    if (!Array.isArray(related) || typeof typeId !== 'number') return;
    const bucket = byType.get(typeId) ?? [];
    for (const id of related) if (typeof id === 'number') bucket.push(id);
    byType.set(typeId, bucket);
  };

  for (const relation of view?.getNewEntities() ?? []) addRelation(relation);

  // Only edited source relationships need their source record decoded. The
  // parsed graph remains the fast path for every unedited relationship.
  const changedIds = new Set(view?.getEffectiveChanges()
    .filter((change) => change.kind === 'attribute' || change.kind === 'type')
    .map((change) => change.entityId) ?? []);
  for (const id of changedIds) {
    if (view?.getNewEntity(id)) continue;
    const positional = view?.getPositionalMutationsForEntity(id);
    if (!positional?.has(4) && !positional?.has(5) && !view?.getEntityTypeMutation(id)) continue;
    const relation = store.getEntity(id);
    if (!relation) continue;
    if (relation.type.toUpperCase() !== 'IFCRELDEFINESBYTYPE'
      && effectiveTreeType(view, id, relation.type)?.toUpperCase() !== 'IFCRELDEFINESBYTYPE') continue;
    rewrittenRelationIds.add(id);
    addRelation(relation);
  }
  return { byType, rewrittenRelationIds };
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
