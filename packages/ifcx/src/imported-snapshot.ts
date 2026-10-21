/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Own composed JSON facts without invoking accessors on uninterpreted values. */
export function snapshotAttribute(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof ArrayBuffer) {
    const copy = value.slice(0); seen.set(value, copy); return copy;
  }
  if (ArrayBuffer.isView(value)) {
    const buffer = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
    const Constructor = value.constructor as new (buffer: ArrayBuffer) => ArrayBufferView;
    const copy = new Constructor(buffer); seen.set(value, copy); return copy;
  }
  if (value instanceof Date) { const copy = new Date(value.getTime()); seen.set(value, copy); return copy; }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>(); seen.set(value, copy);
    for (const [key, item] of value) copy.set(snapshotAttribute(key, seen), snapshotAttribute(item, seen));
    return copy;
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>(); seen.set(value, copy);
    for (const item of value) copy.add(snapshotAttribute(item, seen));
    return copy;
  }
  const copy: object = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) descriptor.value = snapshotAttribute(descriptor.value, seen);
    Object.defineProperty(copy, key, descriptor);
  }
  return copy;
}
