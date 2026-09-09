/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { CooperativeControl } from './cooperative-control.js';

type Copy = (value: unknown) => unknown;
type Frame = Iterator<void>;

/** The overlay's data vocabulary, not a polyfill for every structuredClone host type. */
export async function cloneCooperatively<T>(input: T, control: CooperativeControl): Promise<T> {
  const memo = new WeakMap<object, object>();
  const frames: Frame[] = [];
  let shouldPause = false;
  const charge = (bytes: number) => {
    const due = control.step(bytes);
    shouldPause = shouldPause || due;
  };
  const copy: Copy = value => {
    if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
      charge(16); return value;
    }
    if (typeof value === 'string') { charge(16 + value.length * 2); return value; }
    if (typeof value !== 'object') throw new TypeError('Unsupported value in cooperative entity preparation.');
    const known = memo.get(value);
    if (known) { charge(8); return known; }
    charge(128);
    if (value instanceof Map) {
      const result = new Map<unknown, unknown>(); memo.set(value, result);
      frames.push((function* () {
        for (const [key, item] of value) {
          if (key !== null && typeof key === 'object') throw new TypeError('Mutable map keys are unsupported during cooperative entity preparation.');
          result.set(copy(key), copy(item)); yield;
        }
      })());
      return result;
    }
    if (value instanceof Set) {
      const result = new Set<unknown>(); memo.set(value, result);
      frames.push((function* () { for (const item of value) {
        if (item !== null && typeof item === 'object') throw new TypeError('Mutable set members are unsupported during cooperative entity preparation.');
        result.add(copy(item)); yield;
      } })());
      return result;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Cooperative entity preparation supports plain values, arrays, maps and sets only.');
    }
    if (array) charge(value.length * 8);
    const result = (array ? new Array(value.length) : Object.create(prototype)) as Record<string, unknown>;
    memo.set(value, result);
    frames.push((function* () {
      // Incremental own-property enumeration preserves sparse arrays and extra
      // enumerable properties without constructing Object.keys(hugeArray).
      for (const key in value) {
        charge(48 + key.length * 2);
        if (!Object.hasOwn(value, key)) { yield; continue; }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('Accessors are unsupported during cooperative entity preparation.');
        Object.defineProperty(result, key, { value: copy(descriptor.value), enumerable: true, writable: true, configurable: true });
        yield;
      }
    })());
    return result;
  };
  const result = copy(input);
  while (frames.length || shouldPause) {
    if (shouldPause) { shouldPause = false; await control.pause(); }
    control.checkAbort();
    const frame = frames[frames.length - 1];
    if (frame && frame.next().done) frames.pop();
  }
  return result as T;
}
