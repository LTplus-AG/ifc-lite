/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const encoder = new TextEncoder();
export const textDigest = (text: string): string => bytesToHex(sha256(encoder.encode(text)));

/** Sorted-key JSON, iteratively serialized so deep input cannot exhaust the stack.
 * Generic hosts may supply non-JSON messages. Those remain explicitly unknown;
 * never hash String(value), a credential-bearing host config, or a guessed wire body.
 */
export function logicalInputDigest(value: unknown): { value: string } | { unavailable: 'non-json-input' | 'digest-limit' } {
  type Task = { value: unknown } | { token: string } | { leave: object };
  const pending: Task[] = [{ value }];
  const active = new Set<object>();
  const tokens: string[] = [];
  // Digest-only limits exceed the viewer's 90k context + 1.2M image contract.
  const maxChars = 4_000_000, maxValues = 100_000;
  let chars = 0, values = 0;
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
    active.add(current);
    pending.push({ leave: current }, { token: array ? ']' : '}' });
    if (array) {
      if (current.length > maxValues - values) return limited();
      for (let i = current.length - 1; i >= 0; i--) {
        pending.push({ value: current[i] === undefined ? null : current[i] });
        if (i) pending.push({ token: ',' });
      }
    } else {
      const record = current as Record<string, unknown>;
      const ownKeys = Object.keys(record);
      if (ownKeys.length > maxValues - values) return limited();
      const keys = ownKeys.filter(key => record[key] !== undefined).sort();
      if (keys.some(key => key.length > maxChars)) return limited();
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        pending.push({ value: record[key] }, { token: ':' }, { token: JSON.stringify(key) });
        if (i) pending.push({ token: ',' });
      }
    }
    pending.push({ token: array ? '[' : '{' });
  }
  return { value: textDigest(tokens.join('')) };
}
