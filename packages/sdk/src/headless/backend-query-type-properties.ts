/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PropertySet } from '@ifc-lite/data';
import type { EntityData, EntityRef } from '../index.js';
import type { PendingOverlay } from './overlay.js';

/**
 * Type data with the session's edits applied (#9296): the effective
 * IfcRelDefinesByType (queued, superseded and deleted relationships folded by
 * the adapter's `related`) and the type's property sets as the overlay holds
 * them (its own HasPropertySets and IfcRelDefinesByProperties sets, plus queued
 * property writes).
 */
export function liveTypeProperties(
  ref: EntityRef,
  pending: PendingOverlay,
  related: (ref: EntityRef, relType: string, direction: 'forward' | 'inverse') => EntityRef[],
  entityData: (ref: EntityRef) => EntityData | null,
): { typeName: string; typeId: number; properties: PropertySet[] } | null {
  if (pending.deleted.has(ref.expressId)) return null;
  const typeRef = related(ref, 'IfcRelDefinesByType', 'inverse')[0];
  if (!typeRef) return null;
  const properties = pending.propertySets(typeRef.expressId);
  if (properties.length === 0) return null;
  const type = entityData(typeRef);
  return { typeName: type?.name || type?.type || '', typeId: typeRef.expressId, properties };
}
