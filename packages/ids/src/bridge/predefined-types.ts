/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { type IfcDataStore, extractAllEntityAttributes } from '@ifc-lite/parser';
import { RelationshipType } from '@ifc-lite/data';

/**
 * Resolve the raw `PredefinedType` enum token (e.g. `USERDEFINED`,
 * `NOTDEFINED`, `BEAM`) for an entity, walking through
 * `IfcRelDefinesByType` if the instance has none of its own.
 *
 * Returns `undefined` when neither the instance nor its defining type
 * carry a predefined-type slot.
 */
export function resolveRawPredefinedType(
  store: IfcDataStore,
  expressId: number
): string | undefined {
  const allAttrs = extractAllEntityAttributes(store, expressId);
  const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
  const pdtValue =
    typeof pdt?.value === 'string' && pdt.value ? pdt.value : undefined;
  if (pdtValue && pdtValue !== 'NOTDEFINED') return pdtValue;

  // Inherit from the defining type (IfcRelDefinesByType).
  const typeIds =
    store.relationships?.getRelated?.(
      expressId,
      RelationshipType.DefinesByType,
      'inverse'
    ) || [];
  for (const typeId of typeIds) {
    const typeAttrs = extractAllEntityAttributes(store, typeId);
    const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
    const typeVal =
      typeof typePdt?.value === 'string' && typePdt.value
        ? typePdt.value
        : undefined;
    if (typeVal && typeVal !== 'NOTDEFINED') return typeVal;
  }
  return pdtValue;
}

/**
 * Resolve the IDS-side "object type" — either the predefined enum
 * value, or (when `USERDEFINED`) the user-defined name from the
 * adjacent `ElementType` / `ObjectType` / `ProcessType` /
 * `ResourceType` slot. Walks `IfcRelDefinesByType` if the instance
 * carries neither.
 */
export function resolveObjectType(
  store: IfcDataStore,
  expressId: number,
  fallbackObjectType: () => string | undefined
): string | undefined {
  const allAttrs = extractAllEntityAttributes(store, expressId);
  const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
  const pdtValue = pdt?.value;

  if (
    typeof pdtValue === 'string' &&
    pdtValue &&
    pdtValue !== 'NOTDEFINED' &&
    pdtValue !== 'USERDEFINED'
  ) {
    return pdtValue;
  }

  const userSlot =
    allAttrs.find((a) => a.name === 'ElementType') ||
    allAttrs.find((a) => a.name === 'ObjectType') ||
    allAttrs.find((a) => a.name === 'ProcessType') ||
    allAttrs.find((a) => a.name === 'ResourceType');
  if (userSlot && typeof userSlot.value === 'string' && userSlot.value) {
    return userSlot.value;
  }

  // Inherit from defining type when the instance has neither.
  const typeIds =
    store.relationships?.getRelated?.(
      expressId,
      RelationshipType.DefinesByType,
      'inverse'
    ) || [];
  for (const typeId of typeIds) {
    const typeAttrs = extractAllEntityAttributes(store, typeId);
    const typePdt = typeAttrs.find((a) => a.name === 'PredefinedType');
    const typePdtValue = typePdt?.value;
    if (
      typeof typePdtValue === 'string' &&
      typePdtValue &&
      typePdtValue !== 'NOTDEFINED' &&
      typePdtValue !== 'USERDEFINED'
    ) {
      return typePdtValue;
    }
    const typeUserSlot =
      typeAttrs.find((a) => a.name === 'ElementType') ||
      typeAttrs.find((a) => a.name === 'ObjectType') ||
      typeAttrs.find((a) => a.name === 'ProcessType') ||
      typeAttrs.find((a) => a.name === 'ResourceType');
    if (
      typeUserSlot &&
      typeof typeUserSlot.value === 'string' &&
      typeUserSlot.value
    ) {
      return typeUserSlot.value;
    }
  }

  const fallback = fallbackObjectType();
  if (fallback) return fallback;
  return typeof pdtValue === 'string' && pdtValue ? pdtValue : undefined;
}
