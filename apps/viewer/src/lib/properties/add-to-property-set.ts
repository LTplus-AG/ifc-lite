/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The one way a panel adds properties to an element's property set (#5966).
 *
 * A set the element itself carries gets the properties added. A set the
 * element does not carry is created on it. When that name is a set the
 * element only INHERITS from its type, the new occurrence set carries the
 * type set's properties forward. Otherwise it would hold only the added
 * ones, and a tool that lets an occurrence set replace the type's set of
 * the same name would show the set losing every inherited property (#5672
 * symptom b). The type's set is left untouched; the element gets a copy of
 * its current values, each with its value type and IFC data type. A set
 * holding a property that cannot be copied faithfully is refused instead.
 *
 * The override is written property by property through the store's
 * `setProperty`, which mirrors each write to collab peers (`createPropertySet`
 * is not mirrored), and tagged as one batch: one Ctrl+Z removes it. So is
 * a multi-property add to a set the element already carries.
 */

import type { PropertyValue } from '@ifc-lite/mutations';
import type { Property, PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '@/store';
import { newMutationBatchId } from '@/store/slices/mutation-batch-tags';

export interface AddedProperty {
  name: string;
  value: PropertyValue;
  type: PropertyValueType;
}

/** The element's type, and the sets it inherits from it that it does not carry itself. */
export interface InheritedSets {
  typeId: number;
  typeName: string;
  psetNames: readonly string[];
}

export interface AddToSetTarget {
  modelId: string;
  entityId: number;
  /** Every set name shown for the element, its own and inherited ones. */
  existingPsets: readonly string[];
  inheritedFrom?: InheritedSets | null;
}

/** Whether `psetName` is a set the element only inherits from its type. */
export function isInheritedOnly(target: Pick<AddToSetTarget, 'inheritedFrom'>, psetName: string): boolean {
  return target.inheritedFrom?.psetNames.includes(psetName) ?? false;
}

/** What the add did: written, or refused because a carried property cannot be copied faithfully. */
export type AddToSetResult = { ok: true } | { ok: false; uncopyable: string[] };

/**
 * A type property the override cannot reproduce: the exporter writes every
 * overlay property as a single value and resolves only project length units,
 * so a multi-valued property (enumerated, list, bounded, table, reference,
 * complex) or one with its own unit would land on the element as a different
 * value. Copying it wrong is data loss, not a carry-forward.
 */
function uncopyable(p: Property): boolean {
  return p.structure !== undefined || p.values !== undefined || p.unit !== undefined;
}

export function addToPropertySet(state: ViewerState, target: AddToSetTarget, psetName: string, added: readonly AddedProperty[]): AddToSetResult {
  const { modelId, entityId, inheritedFrom } = target;
  const inheritedOnly = isInheritedOnly(target, psetName);
  if (!inheritedOnly && !target.existingPsets.includes(psetName)) {
    state.createPropertySet(modelId, entityId, psetName, [...added]);
    return { ok: true };
  }
  // Every same-name set the type carries (HasPropertySets and a relationship
  // can both supply one), first occurrence of a property name winning.
  const addedNames = new Set(added.map((p) => p.name));
  const carried = new Map<string, Property>();
  if (inheritedOnly && inheritedFrom) {
    for (const pset of state.mutationViews.get(modelId)?.getForEntity(inheritedFrom.typeId) ?? []) {
      if (pset.name !== psetName) continue;
      for (const p of pset.properties) if (!addedNames.has(p.name) && !carried.has(p.name)) carried.set(p.name, p);
    }
    const refused = [...carried.values()].filter(uncopyable).map((p) => p.name);
    if (refused.length > 0) return { ok: false, uncopyable: refused };
  }
  const ids: string[] = [];
  for (const p of carried.values()) {
    const m = state.setProperty(modelId, entityId, psetName, p.name, p.value, p.type, p.dataType);
    if (m) ids.push(m.id);
  }
  for (const p of added) {
    const m = state.setProperty(modelId, entityId, psetName, p.name, p.value, p.type);
    if (m) ids.push(m.id);
  }
  if (ids.length > 1) state.tagMutationBatch(ids, newMutationBatchId());
  return { ok: true };
}
