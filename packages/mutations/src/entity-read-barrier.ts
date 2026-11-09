// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NewEntity } from './types.js';

let internalReads = 0;
const observers = new WeakMap<NewEntity, Set<() => void>>();

/** Internal snapshots/readers do not hand mutable arrays to a caller. */
export function withoutEntityExposure<T>(read: () => T): T {
  internalReads++;
  try { return read(); } finally { internalReads--; }
}

/** Keep ordinary arrays and structuredClone compatibility. Once a caller has
 * obtained an attribute array, its index must conservatively recheck that row:
 * an alias can be edited again without another getNewEntity call. */
export function observeEntityAttributes(entity: NewEntity, exposed: () => void): void {
  const previous = observers.get(entity);
  if (previous) { previous.add(exposed); return; }
  const descriptor = Object.getOwnPropertyDescriptor(entity, 'attributes');
  if (descriptor && !descriptor.configurable) { exposed(); return; }
  const listeners = new Set([exposed]);
  observers.set(entity, listeners);
  let value = descriptor && 'value' in descriptor
    ? descriptor.value as NewEntity['attributes'] : withoutEntityExposure(() => entity.attributes);
  const notify = () => { for (const listener of listeners) listener(); };
  Object.defineProperty(entity, 'attributes', {
    enumerable: descriptor?.enumerable ?? true, configurable: true,
    get() {
      if (!internalReads) notify();
      return descriptor?.get ? descriptor.get.call(entity) as NewEntity['attributes'] : value;
    },
    set: descriptor?.get && !descriptor.set || descriptor?.writable === false ? undefined : (next: NewEntity['attributes']) => {
      notify();
      if (descriptor?.set) descriptor.set.call(entity, next);
      else value = next;
    },
  });
}

/** A read-only borrow: mutation belongs on the ordinary getter or slot APIs. */
export function readEntitySnapshot(entity: NewEntity): NewEntity {
  return withoutEntityExposure(() => ({ ...entity }));
}
