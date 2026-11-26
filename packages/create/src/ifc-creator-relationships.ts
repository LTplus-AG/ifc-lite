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
   * The `IfcSpace` members of `storeyElements`. A space is a spatial structure
   * element, so `IfcRelContainedInSpatialStructure.WR31` forbids containing it
   * and `IfcSpatialStructureElement.WR41` requires it to be aggregated (#11498).
   */
  spaceIds: ReadonlySet<number>;
  /**
   * Products contained in the site rather than a storey — terrain surfaces and
   * survey annotations, which have no storey to belong to.
   */
  siteElements: readonly number[];
  /**
   * Products aggregated by the project directly — `IfcAlignment`, which IFC 4.3
   * relates to the project rather than containing it in a spatial element.
   */
  projectElements?: readonly number[];
}

/** Every `IfcSpace` the creator made, by any path (`addIfcSpace`, or a generic `addElement`/`addAxisElement`). */
export function spaceIdsOf(entities: readonly { expressId: number; type: string }[]): Set<number> {
  return new Set(entities.filter((e) => e.type.toUpperCase() === 'IFCSPACE').map((e) => e.expressId));
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
  emitRelAggregates(structure.projectId, [structure.siteId, ...(structure.projectElements ?? [])], structure);
  emitRelAggregates(structure.siteId, [structure.buildingId], structure);

  if (structure.storeyIds.length > 0) {
    emitRelAggregates(structure.buildingId, structure.storeyIds, structure);
  }

  for (const [storeyId, memberIds] of structure.storeyElements) {
    const contained = memberIds.filter((id) => !structure.spaceIds.has(id));
    const aggregated = memberIds.filter((id) => structure.spaceIds.has(id));
    if (contained.length > 0) emitRelContainedInSpatialStructure(storeyId, contained, structure);
    if (aggregated.length > 0) emitRelAggregates(storeyId, aggregated, structure);
  }

  if (structure.siteElements.length > 0) {
    emitRelContainedInSpatialStructure(structure.siteId, structure.siteElements, structure);
  }
}
