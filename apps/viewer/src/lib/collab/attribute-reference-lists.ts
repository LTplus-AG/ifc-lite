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

const REFERENCE_SCALAR_ATTRIBUTES = new Set([
  'AppliedValue',
  'Unit',
  'UnitBasis',
  'RelatingActor',
  'RelatingControl',
  'RelatingGroup',
  'RelatingObject',
  'RelatingProcess',
  'RelatingProduct',
  'RelatingResource',
]);

function localReferenceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = /^#([1-9]\d*)$/.exec(value);
  return match ? Number(match[1]) : null;
}

function localAttributeName(attrName: string): string {
  return attrName.split('::').at(-1) ?? attrName;
}

export function isReferenceListAttribute(attrName: string): boolean {
  return REFERENCE_LIST_ATTRIBUTES.has(localAttributeName(attrName));
}

export function isReferenceScalarAttribute(attrName: string): boolean {
  return REFERENCE_SCALAR_ATTRIBUTES.has(localAttributeName(attrName));
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
    const id = localReferenceId(ref);
    if (id === null) return null;
    const path = pathForEntity(store, id);
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
    refs.push(`#${ref}`);
  }
  return refs;
}

/** Encode a scalar STEP reference as a peer-resolvable room path. */
export function referenceScalarToPath(
  store: IfcDataStore,
  attrName: string,
  value: unknown,
): string | null | undefined {
  if (!isReferenceScalarAttribute(attrName)) return undefined;
  const id = localReferenceId(value);
  if (id === null) return undefined;
  return pathForEntity(store, id);
}

/** Restore a room path to the STEP-tagged reference used by the overlay. */
export function referenceScalarFromPath(
  store: IfcDataStore,
  attrName: string,
  value: unknown,
): string | null | undefined {
  if (!isReferenceScalarAttribute(attrName) || typeof value !== 'string' || !value.startsWith('/')) {
    return undefined;
  }
  const ref = entityForPath(store, value);
  return ref === null ? null : `#${ref}`;
}
