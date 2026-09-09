/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Iterative comparison also catches skip-history edits and escaped nested values. */
export function sameOverlayValue(left: unknown, right: unknown): boolean {
  const pending: Array<[unknown, unknown]> = [[left, right]];
  const visited = new WeakMap<object, WeakSet<object>>();
  while (pending.length) {
    const [a, b] = pending.pop()!;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    let matches = visited.get(a);
    if (matches?.has(b)) continue;
    if (!matches) { matches = new WeakSet(); visited.set(a, matches); }
    matches.add(b);
    if (a instanceof Map && b instanceof Map) {
      if (a.size !== b.size) return false;
      for (const [key, value] of a) {
        if (!b.has(key)) return false;
        pending.push([value, b.get(key)]);
      }
    } else if (a instanceof Set && b instanceof Set) {
      if (a.size !== b.size || [...a].some(value => !b.has(value))) return false;
    } else {
      if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
      if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) return false;
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false;
        pending.push([(a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]]);
      }
    }
  }
  return true;
}

