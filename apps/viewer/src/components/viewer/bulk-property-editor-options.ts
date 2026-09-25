/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FilterOperator, MutablePropertyView } from '@ifc-lite/mutations';
import { IfcTypeEnum, type EntityTable } from '@ifc-lite/data';
import type { TranslationKey } from '@/i18n';
import { selectPluralCategory } from '@/i18n/registry';

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

const PLURAL_SUFFIX = {
  zero: 'Zero',
  one: 'One',
  two: 'Two',
  few: 'Few',
  many: 'Many',
  other: 'Other',
} as const;

type AppliedResultKey = Extract<TranslationKey, `bulkPropertyEditor.applied${string}`>;

export function appliedResultKey(locale: string, mutations: number, entities: number): AppliedResultKey {
  const mutationCategory = PLURAL_SUFFIX[selectPluralCategory(locale, mutations)];
  const entityCategory = PLURAL_SUFFIX[selectPluralCategory(locale, entities)];
  return `bulkPropertyEditor.applied${mutationCategory}${entityCategory}` as AppliedResultKey;
}

/**
 * Every IfcTypeEnum present in the model as edited, with its class name: the
 * type facets the editor offers (#5249). A class that exists only because the
 * session created or retyped an entity into it is offered too, or the engine's
 * effective selection (bulk-query-candidates.ts) could never be asked for it.
 */
export function presentTypeEnums(entities: EntityTable, view: MutablePropertyView | null): Map<number, string> {
  const enumToTypeName = new Map<number, string>();
  // @raw-entity-enumeration-ok collects the parsed classes present; overlay creates and retypes are added below, and a tombstone only removes a class once no instance is left, which the candidate pass answers
  for (let i = 0; i < entities.count; i++) {
    const typeEnum = entities.typeEnum[i];
    if (enumToTypeName.has(typeEnum)) continue;
    const typeName = entities.getTypeName(entities.expressId[i]);
    if (typeName) enumToTypeName.set(typeEnum, typeName);
  }
  const overlayTypes = [
    ...(view?.getNewEntities().filter((e) => !view.isDeleted(e.expressId)).map((e) => e.type) ?? []),
    ...Array.from(view?.getTypeMutations().values() ?? [], (m) => m.newType),
  ];
  for (const name of overlayTypes) {
    const typeEnum = IfcTypeEnum[name as keyof typeof IfcTypeEnum];
    if (typeof typeEnum === 'number' && !enumToTypeName.has(typeEnum)) enumToTypeName.set(typeEnum, name);
  }
  return enumToTypeName;
}
