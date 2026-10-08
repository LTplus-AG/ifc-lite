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
export function logicalInputDigest(value: unknown): string | undefined {
  type Task = { value: unknown } | { token: string } | { leave: object };
  const pending: Task[] = [{ value }];
  const active = new Set<object>();
  const tokens: string[] = [];
  while (pending.length) {
    const task = pending.pop()!;
    if ('token' in task) { tokens.push(task.token); continue; }
    if ('leave' in task) { active.delete(task.leave); continue; }
    const current = task.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean'
      || (typeof current === 'number' && Number.isFinite(current))) {
      tokens.push(JSON.stringify(current)); continue;
    }
    if (typeof current !== 'object' || !current || active.has(current)) return undefined;
    const array = Array.isArray(current);
    if (!array && Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) return undefined;
    active.add(current);
    pending.push({ leave: current }, { token: array ? ']' : '}' });
    if (array) {
      for (let i = current.length - 1; i >= 0; i--) {
        pending.push({ value: current[i] === undefined ? null : current[i] });
        if (i) pending.push({ token: ',' });
      }
    } else {
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).filter(key => record[key] !== undefined).sort();
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        pending.push({ value: record[key] }, { token: ':' }, { token: JSON.stringify(key) });
        if (i) pending.push({ token: ',' });
      }
    }
    pending.push({ token: array ? '[' : '{' });
  }
  return textDigest(tokens.join(''));
}
