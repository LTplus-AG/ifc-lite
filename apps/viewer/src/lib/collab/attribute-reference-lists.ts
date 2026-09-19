/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { entityForPath, pathForEntity } from './entity-paths';
import { explicitReferenceId, isPortableReferenceList, isPortableReferenceScalar } from './portable-reference-entities';

export function isReferenceListAttribute(attrName: string): boolean {
  return isPortableReferenceList(attrName);
}

export function isReferenceScalarAttribute(attrName: string): boolean {
  return isPortableReferenceScalar(attrName);
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
    const id = explicitReferenceId(ref);
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
  // AppliedValue is a mixed SELECT: a positive number is commonly the
  // measure itself, not an express-id. Only an explicit STEP `#id` string is
  // portable as a reference here.
  if (attrName.split('::').at(-1) === 'AppliedValue' && typeof value === 'number') return undefined;
  const id = explicitReferenceId(value);
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
