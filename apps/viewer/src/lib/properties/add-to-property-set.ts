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
 * symptom b). The type's set is left untouched.
 */

import type { PropertyValue } from '@ifc-lite/mutations';
import type { PropertyValueType } from '@ifc-lite/data';
import type { ViewerState } from '@/store';

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

export function addToPropertySet(state: ViewerState, target: AddToSetTarget, psetName: string, added: readonly AddedProperty[]): void {
  const { modelId, entityId } = target;
  const inheritedOnly = isInheritedOnly(target, psetName);
  if (target.existingPsets.includes(psetName) && !inheritedOnly) {
    for (const p of added) state.setProperty(modelId, entityId, psetName, p.name, p.value, p.type);
    return;
  }
  const addedNames = new Set(added.map((p) => p.name));
  const carried = inheritedOnly
    ? (state.mutationViews.get(modelId)?.getForEntity(target.inheritedFrom!.typeId) ?? [])
      .find((pset) => pset.name === psetName)?.properties
      .filter((p) => !addedNames.has(p.name))
      .map((p) => ({ name: p.name, value: p.value, type: p.type })) ?? []
    : [];
  state.createPropertySet(modelId, entityId, psetName, [...carried, ...added]);
}
