/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The two structural relation reads that carry model-local expressIds rather
 * than globalIds: the physical-to-analytical link, and the attributes of each
 * `IfcRelConnectsStructuralMember` (and its `IfcRelConnectsWithEccentricity`
 * subtype) beyond the member/connection pair.
 */

import type { BoundaryConditionInfo } from './structural-load-extractor.js';
import { getAttributeNamesForSchema, getInheritanceChain } from './ifc-schema.js';
import { asNumber, asRef, asRefList, asString, readAttr, type RawEntity } from './structural-step-values.js';
import type { StructuralMemberInfo } from './structural-types.js';

export type StructuralMemberRelation = NonNullable<StructuralMemberInfo['IfcRelConnectsStructuralMember']>[number];

export interface StructuralRelationContext {
  schema: string | undefined;
  /** Read a referenced record by id, resolving its effective type. */
  readResource(id: number): RawEntity | undefined;
  typeOf(id: number): string;
  boundaryCondition(id: number): BoundaryConditionInfo | undefined;
}

export const PHYSICAL_LINK_TYPES = ['IFCRELASSIGNSTOPRODUCT', 'IFCRELCONNECTSSTRUCTURALELEMENT'];
export const MEMBER_RELATION_TYPES = ['IFCRELCONNECTSSTRUCTURALMEMBER', 'IFCRELCONNECTSWITHECCENTRICITY'];
/** Every relation class the extractor reads, as STEP stores them. */
export const STRUCTURAL_RELATION_TYPES = [
  ...MEMBER_RELATION_TYPES, ...PHYSICAL_LINK_TYPES, 'IFCRELCONNECTSSTRUCTURALACTIVITY', 'IFCRELASSIGNSTOGROUP',
];

/**
 * Link structural items to the physical products they analyse. Authoring tools
 * write `IfcRelAssignsToProduct` in both orientations (AxisVM puts the item in
 * `RelatedObjects` and the beam in `RelatingProduct`), so the item side is
 * whichever end is a structural member or connection. IFC2X3 also carries
 * `IfcRelConnectsStructuralElement`. An end that is not a physical
 * `IfcProduct` (a direction, or another structural item) is not a link.
 */
export function readPhysicalLinks(
  rels: readonly RawEntity[],
  itemIds: ReadonlySet<number>,
  ctx: StructuralRelationContext,
): { physicalOfItem: Map<number, number[]>; itemsOfPhysical: Record<number, number[]> } {
  const physicalOfItem = new Map<number, number[]>();
  const itemsOfPhysical: Record<number, number[]> = {};
  const attr = (rel: RawEntity, name: string) => readAttr(rel.type, rel.attrs, name, ctx.schema);
  for (const rel of rels) {
    const assigns = rel.type === 'IfcRelAssignsToProduct';
    const product = asRef(attr(rel, assigns ? 'RelatingProduct' : 'RelatingElement'));
    if (product === undefined) continue;
    const objects = assigns ? asRefList(attr(rel, 'RelatedObjects')) : [asRef(attr(rel, 'RelatedStructuralMember'))];
    for (const object of objects) {
      if (object === undefined) continue;
      const [item, physical] = itemIds.has(product) ? [product, object] : [object, product];
      if (!itemIds.has(item)) continue;
      const chain = getInheritanceChain(ctx.typeOf(physical));
      if (!chain.includes('IfcProduct') || chain.includes('IfcStructuralItem') || chain.includes('IfcStructuralActivity')) continue;
      const physicals = physicalOfItem.get(item) ?? [];
      if (!physicals.includes(physical)) physicals.push(physical);
      physicalOfItem.set(item, physicals);
      const items = (itemsOfPhysical[physical] ??= []);
      if (!items.includes(item)) items.push(item);
    }
  }
  return { physicalOfItem, itemsOfPhysical };
}

/** Every attribute of one member/connection relation past the pair itself. */
export function readMemberRelation(rel: RawEntity, connectionId: number, ctx: StructuralRelationContext): StructuralMemberRelation {
  const attr = (e: RawEntity, name: string) => readAttr(e.type, e.attrs, name, ctx.schema);
  const conditionId = asRef(attr(rel, 'AppliedCondition'));
  const constraintId = asRef(attr(rel, 'ConnectionConstraint'));
  const constraint = constraintId === undefined ? undefined : ctx.readResource(constraintId);
  return {
    expressId: rel.expressId,
    RelatedStructuralConnection: connectionId,
    AppliedCondition: conditionId === undefined ? undefined : ctx.boundaryCondition(conditionId),
    AdditionalConditions: additionalCondition(asRef(attr(rel, 'AdditionalConditions')), ctx),
    SupportedLength: asNumber(attr(rel, 'SupportedLength')),
    ConditionCoordinateSystem: asRef(attr(rel, 'ConditionCoordinateSystem')),
    ConnectionConstraint: constraint?.type === 'IfcConnectionPointEccentricity' ? {
      expressId: constraint.expressId,
      EccentricityInX: asNumber(attr(constraint, 'EccentricityInX')),
      EccentricityInY: asNumber(attr(constraint, 'EccentricityInY')),
      EccentricityInZ: asNumber(attr(constraint, 'EccentricityInZ')),
      PointOnRelatingElement: asRef(attr(constraint, 'PointOnRelatingElement')),
      PointOnRelatedElement: asRef(attr(constraint, 'PointOnRelatedElement')),
    } : undefined,
  };
}

/** An `IfcStructuralConnectionCondition` subtype, its numeric attributes keyed by EXPRESS name. */
function additionalCondition(id: number | undefined, ctx: StructuralRelationContext): StructuralMemberRelation['AdditionalConditions'] {
  const e = id === undefined ? undefined : ctx.readResource(id);
  if (!e || !getInheritanceChain(e.type).includes('IfcStructuralConnectionCondition')) return undefined;
  const components: Record<string, number> = {};
  getAttributeNamesForSchema(e.type, ctx.schema).forEach((name, i) => {
    const n = asNumber(e.attrs[i]);
    if (n !== undefined) components[name] = n;
  });
  return { expressId: e.expressId, type: e.type, name: asString(readAttr(e.type, e.attrs, 'Name', ctx.schema)), components };
}
