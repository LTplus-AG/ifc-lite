// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NewEntity } from './types.js';

let internalReads = 0;
const observers = new WeakMap<NewEntity, Set<() => void>>();
const dataBarriers = new WeakMap<object, { getter: PropertyDescriptor['get']; read(): NewEntity['attributes'] }>();
/** Rows whose mutable attribute arrays reached a caller; their borrows are never reused. */
const escaped = new WeakSet<NewEntity>();
const borrows = new WeakMap<NewEntity, NewEntity>();

/** Cooperative cloning may unwrap our own data barrier, never a caller getter. */
export function entityAttributeData(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): PropertyDescriptor | undefined {
  const barrier = key === 'attributes' ? dataBarriers.get(object) : undefined;
  return barrier && descriptor?.get === barrier.getter ? { value: barrier.read() } : undefined;
}

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
  if (descriptor && !descriptor.configurable) { escaped.add(entity); exposed(); return; }
  const listeners = new Set([exposed]);
  observers.set(entity, listeners);
  let value = descriptor && 'value' in descriptor
    ? descriptor.value as NewEntity['attributes'] : withoutEntityExposure(() => entity.attributes);
  const notify = () => {
    escaped.add(entity); borrows.delete(entity);
    for (const listener of listeners) listener();
  };
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
  if (descriptor && 'value' in descriptor) {
    dataBarriers.set(entity, { getter: Object.getOwnPropertyDescriptor(entity, 'attributes')!.get, read: () => value });
  }
}

function frozenCopy(value: unknown, copies: Map<object, unknown>): unknown {
  if (!value || typeof value !== 'object') return value;
  const known = copies.get(value);
  if (known) return known;
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    copies.set(value, out);
    for (let i = 0; i < value.length; i++) out[i] = frozenCopy(value[i], copies);
    return Object.freeze(out);
  }
  const out: Record<string, unknown> = {};
  copies.set(value, out);
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) out[keys[i]!] = frozenCopy((value as Record<string, unknown>)[keys[i]!], copies);
  return Object.freeze(out);
}

/** A read-only borrow: mutation belongs on the ordinary getter or slot APIs.
 * The borrow is a frozen copy, so a write through it throws instead of
 * silently editing a record that no index or transaction guard is watching.
 * Borrowing marks nothing as exposed, and an unexposed row reuses its copy
 * until the row escapes, so repeated scans cost no later transaction (#8452). */
export function readEntitySnapshot(entity: NewEntity): NewEntity {
  const cached = borrows.get(entity);
  if (cached) return cached;
  const row = withoutEntityExposure(() => {
    const copy = { ...entity };
    copy.attributes = frozenCopy(copy.attributes, new Map()) as NewEntity['attributes'];
    return Object.freeze(copy);
  });
  if (dataBarriers.has(entity) && !escaped.has(entity)) borrows.set(entity, row);
  return row;
}
