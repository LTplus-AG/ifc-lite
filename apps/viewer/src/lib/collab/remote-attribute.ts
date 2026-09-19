/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getAttributeNamesAcrossSchemas, type IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { referenceListFromPaths, referenceScalarFromPath } from './attribute-reference-lists';

type RemoteAttributeValue = string | number | boolean | null | unknown[];

/** Apply one peer attribute, restoring room paths to local STEP references. */
export function applyRemoteAttribute(
  view: MutablePropertyView,
  store: IfcDataStore,
  entityId: number,
  attrName: string,
  value: RemoteAttributeValue,
): void {
  const index = getAttributeNamesAcrossSchemas(store.entities.getTypeName(entityId)).indexOf(attrName);
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
  // Null must use the type-agnostic positional serializer. Named REAL/SELECT
  // writers reject the literal string '$' and would retain stale source data.
  if (value === null) {
    if (index >= 0) view.setPositionalAttribute(entityId, index, null);
    return;
  }
  view.setAttribute(entityId, attrName, String(value));
}
