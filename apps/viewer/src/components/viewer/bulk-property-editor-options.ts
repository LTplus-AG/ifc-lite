/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FilterOperator } from '@ifc-lite/mutations';
import type { TranslationKey } from '@/i18n';

/** Common IFC product types offered by the editor; patterns match canonical type names. */
export const IFC_TYPE_MAP: Record<string, { labelKey: TranslationKey; pattern: string }> = {
  IfcWall: { labelKey: 'bulkPropertyEditor.type.wall', pattern: 'Wall' },
  IfcWallStandardCase: { labelKey: 'bulkPropertyEditor.type.wallStandard', pattern: 'WallStandardCase' },
  IfcDoor: { labelKey: 'bulkPropertyEditor.type.door', pattern: 'Door' },
  IfcWindow: { labelKey: 'bulkPropertyEditor.type.window', pattern: 'Window' },
  IfcSlab: { labelKey: 'bulkPropertyEditor.type.slab', pattern: 'Slab' },
  IfcColumn: { labelKey: 'bulkPropertyEditor.type.column', pattern: 'Column' },
  IfcBeam: { labelKey: 'bulkPropertyEditor.type.beam', pattern: 'Beam' },
  IfcRoof: { labelKey: 'bulkPropertyEditor.type.roof', pattern: 'Roof' },
  IfcStair: { labelKey: 'bulkPropertyEditor.type.stair', pattern: 'Stair' },
  IfcRailing: { labelKey: 'bulkPropertyEditor.type.railing', pattern: 'Railing' },
  IfcCurtainWall: { labelKey: 'bulkPropertyEditor.type.curtainWall', pattern: 'CurtainWall' },
  IfcCovering: { labelKey: 'bulkPropertyEditor.type.covering', pattern: 'Covering' },
  IfcPlate: { labelKey: 'bulkPropertyEditor.type.plate', pattern: 'Plate' },
  IfcMember: { labelKey: 'bulkPropertyEditor.type.member', pattern: 'Member' },
  IfcFurnishingElement: { labelKey: 'bulkPropertyEditor.type.furniture', pattern: 'Furnishing' },
  IfcBuildingElementProxy: { labelKey: 'bulkPropertyEditor.type.proxy', pattern: 'BuildingElementProxy' },
  IfcSpace: { labelKey: 'bulkPropertyEditor.type.space', pattern: 'Space' },
  IfcOpeningElement: { labelKey: 'bulkPropertyEditor.type.opening', pattern: 'Opening' },
};

export const FILTER_OPERATORS: { value: FilterOperator; labelKey: TranslationKey }[] = [
  { value: '=', labelKey: 'bulkPropertyEditor.operator.equals' },
  { value: '!=', labelKey: 'bulkPropertyEditor.operator.notEquals' },
  { value: '>', labelKey: 'bulkPropertyEditor.operator.greater' },
  { value: '<', labelKey: 'bulkPropertyEditor.operator.less' },
  { value: '>=', labelKey: 'bulkPropertyEditor.operator.greaterOrEqual' },
  { value: '<=', labelKey: 'bulkPropertyEditor.operator.lessOrEqual' },
  { value: 'CONTAINS', labelKey: 'bulkPropertyEditor.operator.contains' },
  { value: 'STARTS_WITH', labelKey: 'bulkPropertyEditor.operator.startsWith' },
  { value: 'IS_NULL', labelKey: 'bulkPropertyEditor.operator.isNull' },
  { value: 'IS_NOT_NULL', labelKey: 'bulkPropertyEditor.operator.isNotNull' },
];

/** Exact IFC EXPRESS attribute names; intentionally not translated or aliased. */
export const IFC_ATTRIBUTE_LABELS = {
  name: 'Name',
  description: 'Description',
  objectType: 'ObjectType',
} as const;

export function appliedResultKey(mutations: number, entities: number): TranslationKey {
  if (mutations === 1) {
    return entities === 1 ? 'bulkPropertyEditor.appliedOneOne' : 'bulkPropertyEditor.appliedOneOther';
  }
  return entities === 1 ? 'bulkPropertyEditor.appliedOtherOne' : 'bulkPropertyEditor.appliedOtherOther';
}
