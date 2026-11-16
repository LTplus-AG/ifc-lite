// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { NewEntity } from './types.js';

let internalReads = 0;
type ExposureListener = (entity: NewEntity) => void;
interface AttributeBarrier {
  value: NewEntity['attributes'];
  descriptor?: PropertyDescriptor;
  listeners: ExposureListener | Set<ExposureListener>;
}
const barriers = new WeakMap<object, AttributeBarrier>();
/** Rows whose mutable attribute arrays reached a caller; their borrows are never reused. */
const escaped = new WeakSet<NewEntity>();
const borrows = new WeakMap<NewEntity, { row: NewEntity; slot: number }>();
// A session owns its live rows, so weak keys alone do not bound the retained
// frozen copies. A finite FIFO keeps hot reads cheap without a second model.
const BORROW_CACHE_LIMIT = 65_536;
// WeakRef targets stay alive until the current JavaScript job ends. A long
// synchronous authoring/export session must be able to collect evicted rows
// before returning to the event loop, so retain only this bounded FIFO.
const borrowSlots: NewEntity[] = [];
let nextBorrowSlot = 0;

/** Cooperative cloning may unwrap our own data barrier, never a caller getter. */
export function entityAttributeData(object: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined): PropertyDescriptor | undefined {
  const barrier = key === 'attributes' ? barriers.get(object) : undefined;
  return barrier && !barrier.descriptor && descriptor?.get === readAttributes ? { value: barrier.value } : undefined;
}

/** Internal snapshots/readers do not hand mutable arrays to a caller. */
export function withoutEntityExposure<T>(read: () => T): T {
  internalReads++;
  try { return read(); } finally { internalReads--; }
}

/** Keep ordinary arrays and structuredClone compatibility. Once a caller has
 * obtained an attribute array, its index must conservatively recheck that row:
 * an alias can be edited again without another getNewEntity call. */
function notify(entity: NewEntity, barrier: AttributeBarrier): void {
  escaped.add(entity); borrows.delete(entity);
  if (typeof barrier.listeners === 'function') barrier.listeners(entity);
  else for (const listener of barrier.listeners) listener(entity);
}

// One accessor pair for every ordinary row. Its data lives in a weak record,
// rather than closures (and a descriptor/read closure) retained per IFC atom.
function readAttributes(this: NewEntity): NewEntity['attributes'] {
  const barrier = barriers.get(this)!;
  if (!internalReads) notify(this, barrier);
  return barrier.descriptor?.get ? barrier.descriptor.get.call(this) as NewEntity['attributes'] : barrier.value;
}
function writeAttributes(this: NewEntity, next: NewEntity['attributes']): void {
  const barrier = barriers.get(this)!;
  notify(this, barrier);
  if (barrier.descriptor?.set) barrier.descriptor.set.call(this, next);
  else barrier.value = next;
}

export function observeEntityAttributes(entity: NewEntity, exposed: ExposureListener): void {
  const previous = barriers.get(entity);
  if (previous) {
    if (previous.listeners !== exposed) {
      if (typeof previous.listeners === 'function') previous.listeners = new Set([previous.listeners]);
      previous.listeners.add(exposed);
    }
    // A previously returned array can change without another getter, including
    // after a transaction rebuilds its temporary reference indexes.
    if (escaped.has(entity)) exposed(entity);
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(entity, 'attributes');
  if (descriptor && !descriptor.configurable) { escaped.add(entity); exposed(entity); return; }
  const value = descriptor && 'value' in descriptor
    ? descriptor.value as NewEntity['attributes'] : withoutEntityExposure(() => entity.attributes);
  barriers.set(entity, { value, listeners: exposed, ...(descriptor?.get || descriptor?.set ? { descriptor } : {}) });
  Object.defineProperty(entity, 'attributes', {
    enumerable: descriptor?.enumerable ?? true, configurable: true,
    get: readAttributes,
    set: descriptor?.get && !descriptor.set || descriptor?.writable === false ? undefined : writeAttributes,
  });
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
 * while cached, so repeated scans cost no later transaction (#8452). Cold
 * copies can be evicted; held borrows stay frozen and detached. */
export function readEntitySnapshot(entity: NewEntity): NewEntity {
  const cached = borrows.get(entity);
  if (cached) return cached.row;
  const row = withoutEntityExposure(() => {
    const copy = { ...entity };
    copy.attributes = frozenCopy(copy.attributes, new Map()) as NewEntity['attributes'];
    return Object.freeze(copy);
  });
  if (barriers.has(entity) && !escaped.has(entity)) {
    const previous = borrowSlots[nextBorrowSlot];
    if (previous && borrows.get(previous)?.slot === nextBorrowSlot) borrows.delete(previous);
    borrows.set(entity, { row, slot: nextBorrowSlot });
    borrowSlots[nextBorrowSlot] = entity;
    nextBorrowSlot = (nextBorrowSlot + 1) % BORROW_CACHE_LIMIT;
  }
  return row;
}
