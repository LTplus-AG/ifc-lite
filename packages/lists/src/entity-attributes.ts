/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { CellValue, ListDataProvider } from './types.js';

/** The built-in entity attributes a list column may read (`ColumnDefinition.attribute`). */
export const ENTITY_ATTRIBUTES = [
  'Name',
  'LongName',
  'GlobalId',
  'Class',
  'Type',
  'Description',
  'ObjectType',
  'PredefinedType',
  'Tag',
] as const;

export type EntityAttribute = typeof ENTITY_ATTRIBUTES[number];

/** Read one built-in entity attribute (see {@link ENTITY_ATTRIBUTES}) for a
 *  column cell or a condition; null when the entity has no value for it. */
export function getAttributeValue(entityId: number, attrName: string, provider: ListDataProvider): CellValue {
  switch (attrName) {
    case 'Name':
      return provider.getEntityName(entityId) || null;
    case 'LongName':
      // Declared by the spatial elements (IfcSite / IfcBuilding /
      // IfcBuildingStorey / IfcSpace, IFC4+ IfcSpatialZone), IfcProject and,
      // from IFC4, IfcZone / IfcDistributionSystem / IfcBuildingSystem; null
      // for every class without the attribute (issue #7385).
      return provider.getEntityLongName?.(entityId) || null;
    case 'GlobalId':
      return provider.getEntityGlobalId(entityId) || null;
    case 'Class':
      return provider.getEntityTypeName(entityId) || null;
    case 'Type':
      // The element's IfcTypeProduct name (issue #1754).
      return provider.getEntityDefiningTypeName?.(entityId) || null;
    case 'Description':
      return provider.getEntityDescription(entityId) || null;
    case 'ObjectType':
      return provider.getEntityObjectType(entityId) || null;
    case 'PredefinedType':
      return provider.getEntityPredefinedType?.(entityId) || null;
    case 'Tag':
      return provider.getEntityTag(entityId) || null;
    default:
      return null;
  }
}
