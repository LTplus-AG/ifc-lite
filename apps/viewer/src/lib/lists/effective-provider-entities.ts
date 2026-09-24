/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { IfcTypeEnum, IfcTypeEnumFromString, exactTypeName, type QuantitySet } from '@ifc-lite/data';
import { iterateEffectiveEntityIds, type MutablePropertyView } from '@ifc-lite/mutations';
import {
  getAttributeNamesForSchema,
  isQueryableObjectType,
  normalizeIfcTypeName,
  resolveEffectiveEntityRecord,
  type IfcDataStore,
} from '@ifc-lite/parser';

/** Snapshot one provider's live membership. The viewer rebuilds providers on mutationVersion. */
export function effectiveListEntitySets(store: IfcDataStore, view: MutablePropertyView) {
  const byType = new Map<IfcTypeEnum, number[]>();
  const selectable: number[] = [];
  for (const row of iterateEffectiveEntityIds(store, view, undefined, store.entities.expressId)) {
    const type = IfcTypeEnumFromString(row.type);
    const bucket = byType.get(type);
    if (bucket) bucket.push(row.expressId);
    else byType.set(type, [row.expressId]);
    if (isQueryableObjectType(row.type)
      && (row.overlayCreated || store.entities.hasGeometry(row.expressId))) {
      selectable.push(row.expressId);
    }
  }
  return { byType, selectable };
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    if (value === '$' || value === '*') return '';
    const trimmed = value.trim();
    return trimmed.startsWith("'") && trimmed.endsWith("'")
      ? trimmed.slice(1, -1).replace(/''/g, "'") : value;
  }
  if (value && typeof value === 'object' && 'typed' in value) {
    const typed = value.typed;
    if (typed && typeof typed === 'object' && 'value' in typed) return textValue(typed.value);
  }
  return '';
}

/** Read an IFC string attribute as the pending STEP export would write it. */
export function effectiveListStringAttribute(
  store: IfcDataStore,
  view: MutablePropertyView | undefined,
  expressId: number,
  name: string,
  base: () => string,
): string {
  if (!view) return base();
  const created = view.getNewEntity(expressId);
  const retype = view.getEntityTypeMutation(expressId)?.newType;
  const named = view.getAttributeMutationsForEntity(expressId);
  const positional = view.getPositionalMutationsForEntity(expressId);
  if (created) {
    const record = resolveEffectiveEntityRecord(created, {
      retype,
      named: named.map(({ name: key, value }) => [key, value] as const),
      positional: positional ?? [],
    }, store.schemaVersion);
    const index = record.names.indexOf(name);
    return index >= 0 ? textValue(record.attributes[index]) : '';
  }
  if (!retype && named.length === 0 && !positional?.size) return base();
  const type = retype ?? store.entities.getTypeName(expressId);
  const names = getAttributeNamesForSchema(type, store.schemaVersion);
  const index = names.indexOf(name);
  if (index < 0) return '';
  if (positional?.has(index)) return textValue(positional.get(index));
  const edit = named.find((entry) => entry.name === name);
  return edit ? textValue(edit.value) : base();
}

export function effectiveListTypeName(store: IfcDataStore, view: MutablePropertyView | undefined, expressId: number): string {
  if (view?.isDeleted(expressId)) return '';
  const type = view?.getEntityTypeMutation(expressId)?.newType
    ?? view?.getNewEntity(expressId)?.type
    ?? exactTypeName(store.entities, expressId);
  return type ? normalizeIfcTypeName(type) : '';
}

/** Type-owned quantities use the type-specific base extractor; overlay edits win by name. */
export function effectiveTypeQuantitySets(base: QuantitySet[], typeId: number, view: MutablePropertyView | undefined): QuantitySet[] {
  if (!view?.hasChanges(typeId)) return base;
  const visibleBase = base.filter((set) => !view.isQuantitySetDeleted(typeId, set.name));
  const overlay = view.getQuantitiesForEntity(typeId);
  const byName = new Map(overlay.map((set) => [set.name, set]));
  return [
    ...overlay.map((set) => {
      const baseSet = visibleBase.find((candidate) => candidate.name === set.name);
      if (!baseSet) return set;
      const edited = new Set(set.quantities.map((quantity) => quantity.name));
      return { ...set, quantities: [...set.quantities, ...baseSet.quantities.filter((quantity) => !edited.has(quantity.name))] };
    }),
    ...visibleBase.filter((set) => !byName.has(set.name)),
  ];
}
