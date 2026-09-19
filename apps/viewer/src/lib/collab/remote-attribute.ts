/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue, MutablePropertyView } from '@ifc-lite/mutations';
import { referenceListFromPaths, referenceScalarFromPath } from './attribute-reference-lists';

type RemoteAttributeValue = unknown;

/** Apply one peer attribute, restoring room paths to local STEP references. */
export function applyRemoteAttribute(
  view: MutablePropertyView,
  store: IfcDataStore,
  entityId: number,
  attrName: string,
  value: RemoteAttributeValue,
): void {
  const plainName = attrName.startsWith('bsi::ifc::prop::')
    ? attrName.slice('bsi::ifc::prop::'.length)
    : attrName;
  const sourceType = store.entities.getTypeName(entityId);
  const entityType = sourceType && sourceType !== 'Unknown'
    ? sourceType
    : view.getNewEntity(entityId)?.type ?? sourceType;
  const index = getAttributeNamesAcrossSchemas(entityType).indexOf(plainName);
  const refs = referenceListFromPaths(store, attrName, value);
  if (refs !== undefined) {
    if (refs !== null && index >= 0) view.setPositionalAttribute(entityId, index, refs);
    return;
  }
  const ref = referenceScalarFromPath(store, attrName, value);
  if (ref !== undefined) {
    if (ref !== null && index >= 0) view.setPositionalAttribute(entityId, index, ref);
    return;
  }
  // The positional serializer preserves typed SELECTs, lists, booleans and
  // numeric measures. Stringifying here turns `{ typed: ... }` into
  // `[object Object]` and corrupts the peer's STEP record.
  if (index >= 0) {
    view.setPositionalAttribute(entityId, index, value as IfcAttributeValue);
    return;
  }
  if (value !== null && value !== undefined) view.setAttribute(entityId, plainName, String(value));
}
