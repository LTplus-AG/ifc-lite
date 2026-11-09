/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { qualifiedKey } from './exclude.js';
import type { ClashElement, ClashElementRef } from './types.js';

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

/** A model-independent decision key. Ambiguous keys fail closed if refs change.
 * Escape the reserved prefix even on ordinary keys, so literal keys cannot
 * impersonate encoded identities. Normal IFC GUIDs retain their existing keys. */
export function clashElementIdentity(element: Pick<ClashElementRef, 'key' | 'ref' | 'keyAmbiguous'>): string {
  return element.keyAmbiguous || element.key.startsWith('@') || /\s/.test(element.key)
    ? `@${JSON.stringify([element.key, element.keyAmbiguous ? element.ref : null])}` : element.key;
}

/** Preserve ordinary IDs; encode exceptional fields as one unambiguous tuple. */
export function clashPairId(rule: string, a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return rule.startsWith('@') || /\s/.test(rule) || lo.startsWith('@') || hi.startsWith('@')
    ? `@${JSON.stringify([rule, lo, hi])}` : `${rule} ${lo} ${hi}`;
}

/** Share repeated-key discovery between finding IDs and reviewable endpoints. */
export function clashObjectIdentity(elements: readonly ClashElement[]): {
  pairKey: (element: ClashElement) => string;
  toRef: (element: ClashElement) => ClashElementRef;
} {
  const ambiguous = new Set<string>();
  const refs = new Map<string, number>();
  for (const element of elements) {
    const key = qualifiedKey(element.model, element.key);
    const first = refs.get(key);
    if (first === undefined) refs.set(key, element.ref);
    else if (first !== element.ref) ambiguous.add(key);
  }
  const isAmbiguous = (element: ClashElement) => ambiguous.has(qualifiedKey(element.model, element.key));
  return {
    pairKey: element => {
      const repeated = isAmbiguous(element);
      return repeated || element.model.startsWith('@') || /\s/.test(element.model)
        || element.key.startsWith('@') || /\s/.test(element.key)
        ? `@${JSON.stringify([element.model, element.key, repeated ? element.ref : null])}`
        : `${element.model} ${element.key}`;
    },
    toRef: element => ({ key: element.key, ref: element.ref, model: element.model, tag: element.tag, name: element.name,
      ...(isAmbiguous(element) ? { keyAmbiguous: true as const } : {}) }),
  };
}
