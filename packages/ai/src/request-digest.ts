/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
export const textDigest = (text: string): string => bytesToHex(sha256(encoder.encode(text)));

/** Sorted-key JSON from the core's OWN parsed producer snapshot, iteratively serialized.
 * No caller objects, getters, proxies or guessed wire bodies enter this private helper. */
function digestDataProperties(value: unknown): { value: string } | { unavailable: 'non-json-input' | 'digest-limit' } {
  type Task = { value: unknown } | { token: string } | { leave: object };
  const pending: Task[] = [{ value }];
  const active = new Set<object>();
  const tokens: string[] = [];
  // Digest-only limits exceed the viewer's 90k context + 1.2M image contract.
  const maxChars = 4_000_000, maxValues = 100_000;
  let chars = 0, values = 0, fields = 0;
  const token = (text: string) => { chars += text.length; if (chars > maxChars) return false; tokens.push(text); return true; };
  const limited = () => ({ unavailable: 'digest-limit' as const });
  while (pending.length) {
    const task = pending.pop()!;
    if ('token' in task) { if (!token(task.token)) return limited(); continue; }
    if ('leave' in task) { active.delete(task.leave); continue; }
    if (++values > maxValues) return limited();
    const current = task.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean'
      || (typeof current === 'number' && Number.isFinite(current))) {
      if (typeof current === 'string' && current.length > maxChars) return limited();
      if (!token(JSON.stringify(current))) return limited(); continue;
    }
    if (typeof current !== 'object' || !current || active.has(current)) return { unavailable: 'non-json-input' };
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return { unavailable: 'non-json-input' };
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const ownKeys = Object.keys(descriptors); fields += ownKeys.length;
    if (fields + values > maxValues) return limited();
    if (ownKeys.some(key => !('value' in descriptors[key])) || typeof descriptors.toJSON?.value === 'function') return { unavailable: 'non-json-input' };
    active.add(current);
    pending.push({ leave: current }, { token: array ? ']' : '}' });
    if (array) {
      if (descriptors.length.value > maxValues - values) return limited();
      for (let i = descriptors.length.value - 1; i >= 0; i--) {
        const item = descriptors[String(i)]?.value;
        pending.push({ value: item === undefined ? null : item });
        if (i) pending.push({ token: ',' });
      }
    } else {
      const keys = ownKeys.filter(key => descriptors[key].enumerable && descriptors[key].value !== undefined).sort();
      if (keys.some(key => key.length > maxChars)) return limited();
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        pending.push({ value: descriptors[key].value }, { token: ':' }, { token: JSON.stringify(key) });
        if (i) pending.push({ token: ',' });
      }
    }
    pending.push({ token: array ? '[' : '{' });
  }
  return { value: textDigest(tokens.join('')) };
}

/** Only the private parsed-snapshot boundary calls this function. Generic input is unknown. */
export function logicalInputDigest(value: unknown): { value: string } | { unavailable: 'non-json-input' | 'digest-limit' } {
  return digestDataProperties(value);
}
