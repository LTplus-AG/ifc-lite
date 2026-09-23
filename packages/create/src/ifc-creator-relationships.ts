/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `IfcRel*` rows `IfcCreator` writes once, at `toIfc()`.
 *
 * Split out of `ifc-creator.ts` for the same reason as the other emitter
 * modules: this is pure STEP assembly over collections the creator already
 * holds, and it needs nothing from the class but the `emit` hook.
 */

/** The creator hooks these emitters need. */
export interface RelationshipContext {
  emit: (type: string, attrs: string) => number;
  newGlobalId: () => string;
  /** `#<id>` of the shared `IfcOwnerHistory`. */
  ownerRef: string;
}

export interface SpatialStructure extends RelationshipContext {
  projectId: number;
  siteId: number;
  buildingId: number;
  storeyIds: readonly number[];
  storeyElements: ReadonlyMap<number, readonly number[]>;
  /**
   * Products contained in the site rather than a storey — terrain surfaces and
   * survey annotations, which have no storey to belong to.
   */
  siteElements: readonly number[];
}

function refs(ids: readonly number[]): string {
  return ids.map((id) => `#${id}`).join(',');
}

export function emitRelAggregates(
  relatingId: number, relatedIds: readonly number[], ctx: RelationshipContext,
): number {
  return ctx.emit('IFCRELAGGREGATES', `'${ctx.newGlobalId()}',${ctx.ownerRef},$,$,#${relatingId},(${refs(relatedIds)})`);
}

export function emitRelContainedInSpatialStructure(
  structureId: number, elementIds: readonly number[], ctx: RelationshipContext,
): number {
  return ctx.emit(
    'IFCRELCONTAINEDINSPATIALSTRUCTURE',
    `'${ctx.newGlobalId()}',${ctx.ownerRef},$,$,(${refs(elementIds)}),#${structureId}`,
  );
}

export function emitRelFillsElement(
  openingId: number, fillingId: number, ctx: RelationshipContext,
): number {
  return ctx.emit('IFCRELFILLSELEMENT', `'${ctx.newGlobalId()}',${ctx.ownerRef},$,$,#${openingId},#${fillingId}`);
}

/**
 * Project → site → building → storeys, then each container's contents.
 *
 * An empty collection writes no row at all: `IfcRelAggregates.RelatedObjects`
 * and `IfcRelContainedInSpatialStructure.RelatedElements` are both `SET [1:?]`,
 * so an empty one is invalid rather than merely useless.
 */
export function emitSpatialRelationships(structure: SpatialStructure): void {
  emitRelAggregates(structure.projectId, [structure.siteId], structure);
  emitRelAggregates(structure.siteId, [structure.buildingId], structure);

  if (structure.storeyIds.length > 0) {
    emitRelAggregates(structure.buildingId, structure.storeyIds, structure);
  }

  for (const [storeyId, elementIds] of structure.storeyElements) {
    if (elementIds.length > 0) {
      emitRelContainedInSpatialStructure(storeyId, elementIds, structure);
    }
  }

  if (structure.siteElements.length > 0) {
    emitRelContainedInSpatialStructure(structure.siteId, structure.siteElements, structure);
  }
}
