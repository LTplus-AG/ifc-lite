/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { qualifiedKey } from './exclude.js';
import type { ClashElement } from './types.js';

type ObjectRef = Pick<ClashElement, 'model' | 'ref'>;
/** One coverage entry per source object, regardless of matched sides or mesh parts. */
export function matchedClashObjects(elements: Iterable<Pick<ClashElement, 'model' | 'key' | 'ref'>>): Array<Pick<ClashElement, 'model' | 'key' | 'ref'>> {
  const objects = new Map<string, Pick<ClashElement, 'model' | 'key' | 'ref'>>();
  for (const { model, key, ref } of elements) objects.set(JSON.stringify([model, ref]), { model, key, ref });
  return [...objects.values()];
}
/** Mesh/material/instance parts share a reference; repeated GlobalIds do not (#9259). */
export function sameClashObject(a: ObjectRef, b: ObjectRef): boolean {
  return a.model === b.model && a.ref === b.ref;
}

/** Preserve existing durable pair ids for valid keys; disambiguate broken repeated GlobalIds by ref. */
export function clashObjectPairKey(elements: readonly ClashElement[]): (element: ClashElement) => string {
  const ambiguous = new Set<string>();
  const refs = new Map<string, number>();
  for (const element of elements) {
    const key = qualifiedKey(element.model, element.key);
    const first = refs.get(key);
    if (first === undefined) refs.set(key, element.ref);
    else if (first !== element.ref) ambiguous.add(key);
  }
  return element => {
    const durable = `${element.model} ${element.key}`;
    return ambiguous.has(qualifiedKey(element.model, element.key)) ? `${durable}#${element.ref}` : durable;
  };
}
