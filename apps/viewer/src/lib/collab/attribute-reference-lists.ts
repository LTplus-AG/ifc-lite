/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { entityForPath, pathForEntity } from './entity-paths';

const REFERENCE_LIST_ATTRIBUTES = new Set([
  'Components',
  'CostQuantities',
  'CostValues',
  'RelatedObjects',
]);

export function isReferenceListAttribute(attrName: string): boolean {
  return REFERENCE_LIST_ATTRIBUTES.has(attrName.split('::').at(-1) ?? attrName);
}

/** `undefined`: ordinary attribute; `null`: reference list could not resolve. */
export function referenceListToPaths(
  store: IfcDataStore,
  attrName: string,
  value: unknown,
): string[] | null | undefined {
  if (!isReferenceListAttribute(attrName) || !Array.isArray(value)) return undefined;
  const paths: string[] = [];
  for (const ref of value) {
    if (typeof ref !== 'number') return null;
    const path = pathForEntity(store, ref);
    if (!path) return null;
    paths.push(path);
  }
  return paths;
}

/** Decode peer room paths into this store's express ids. */
export function referenceListFromPaths(
  store: IfcDataStore,
  attrName: string,
  value: unknown,
): IfcAttributeValue[] | null | undefined {
  if (!isReferenceListAttribute(attrName) || !Array.isArray(value)) return undefined;
  const refs: IfcAttributeValue[] = [];
  for (const path of value) {
    if (typeof path !== 'string') return null;
    const ref = entityForPath(store, path);
    if (ref === null) return null;
    refs.push(ref);
  }
  return refs;
}
