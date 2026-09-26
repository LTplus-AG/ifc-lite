/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FilterOperator, MutablePropertyView } from '@ifc-lite/mutations';
import { IfcTypeEnum, type EntityTable } from '@ifc-lite/data';
import { getInheritanceChainAcrossSchemas } from '@ifc-lite/parser';
import type { TranslationKey } from '@/i18n';
import { selectPluralCategory } from '@/i18n/registry';
import { BULK_OPERATOR_LABEL_KEYS } from '@/lib/filter-operator-labels';

/**
 * Common IFC product classes offered by the editor, keyed by exact class name.
 * A target selects its class and that class's schema subtypes only
 * (`classTargetEnums`).
 */
export const IFC_TYPE_MAP: Record<string, { labelKey: TranslationKey }> = {
  IfcWall: { labelKey: 'bulkPropertyEditor.type.wall' },
  IfcWallStandardCase: { labelKey: 'bulkPropertyEditor.type.wallStandard' },
  IfcDoor: { labelKey: 'bulkPropertyEditor.type.door' },
  IfcWindow: { labelKey: 'bulkPropertyEditor.type.window' },
  IfcSlab: { labelKey: 'bulkPropertyEditor.type.slab' },
  IfcColumn: { labelKey: 'bulkPropertyEditor.type.column' },
  IfcBeam: { labelKey: 'bulkPropertyEditor.type.beam' },
  IfcRoof: { labelKey: 'bulkPropertyEditor.type.roof' },
  IfcStair: { labelKey: 'bulkPropertyEditor.type.stair' },
  IfcRailing: { labelKey: 'bulkPropertyEditor.type.railing' },
  IfcCurtainWall: { labelKey: 'bulkPropertyEditor.type.curtainWall' },
  IfcCovering: { labelKey: 'bulkPropertyEditor.type.covering' },
  IfcPlate: { labelKey: 'bulkPropertyEditor.type.plate' },
  IfcMember: { labelKey: 'bulkPropertyEditor.type.member' },
  IfcFurnishingElement: { labelKey: 'bulkPropertyEditor.type.furniture' },
  IfcBuildingElementProxy: { labelKey: 'bulkPropertyEditor.type.proxy' },
  IfcSpace: { labelKey: 'bulkPropertyEditor.type.space' },
  IfcOpeningElement: { labelKey: 'bulkPropertyEditor.type.opening' },
};

export const FILTER_OPERATORS: { value: FilterOperator; labelKey: TranslationKey }[] = [
  { value: '=', labelKey: BULK_OPERATOR_LABEL_KEYS['='] },
  { value: '!=', labelKey: BULK_OPERATOR_LABEL_KEYS['!='] },
  { value: '>', labelKey: BULK_OPERATOR_LABEL_KEYS['>'] },
  { value: '<', labelKey: BULK_OPERATOR_LABEL_KEYS['<'] },
  { value: '>=', labelKey: BULK_OPERATOR_LABEL_KEYS['>='] },
  { value: '<=', labelKey: BULK_OPERATOR_LABEL_KEYS['<='] },
  { value: 'CONTAINS', labelKey: BULK_OPERATOR_LABEL_KEYS.CONTAINS },
  { value: 'STARTS_WITH', labelKey: BULK_OPERATOR_LABEL_KEYS.STARTS_WITH },
  { value: 'IS_NULL', labelKey: BULK_OPERATOR_LABEL_KEYS.IS_NULL },
  { value: 'IS_NOT_NULL', labelKey: BULK_OPERATOR_LABEL_KEYS.IS_NOT_NULL },
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

/**
 * The present classes (from `presentTypeEnums`) a class target selects: the
 * class itself and its schema subtypes, e.g. `IfcWallStandardCase` under
 * `IfcWall`. Never a class that merely shares a name fragment
 * (`IfcCurtainWall`, `IfcStairFlight`) or a type object (`IfcWallType`),
 * which a substring match used to sweep in (#5864).
 */
export function classTargetEnums(target: string, present: ReadonlyMap<number, string>): number[] {
  const enums: number[] = [];
  for (const [typeEnum, typeName] of present) {
    if (getInheritanceChainAcrossSchemas(typeName.toUpperCase()).includes(target)) enums.push(typeEnum);
  }
  return enums;
}
