/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #7372: reject a whole capture instead of retaining a silently partial graph. */
export function reviewValueFits(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let work = 0;
  let text = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item || ++work > 100_000 || item.depth > 24) return false;
    const x = item.value;
    if (typeof x === 'string') {
      if (x.length > 16_384 || (text += x.length) > 1_048_576) return false;
    } else if (typeof x === 'number') {
      if (!Number.isFinite(x)) return false;
    } else if (x instanceof Date) {
      if (!Number.isFinite(x.getTime())) return false;
    } else if (x !== null && typeof x === 'object') {
      const children = Array.isArray(x) ? x : Object.values(x);
      if (children.length > 10_000 || pending.length + children.length > 100_000) return false;
      for (const child of children) pending.push({ value: child, depth: item.depth + 1 });
    } else if (x !== null && x !== undefined && typeof x !== 'boolean') return false;
  }
  return true;
}

export async function reviewSHA256(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** Both raw and JSON-escaped credentials are excluded from cross-tool facts. */
export function reviewContainsSecret(serialized: string, values: readonly string[]): boolean {
  return values.some(value => value.length > 0 && (serialized.includes(value)
    || serialized.includes(JSON.stringify(value).slice(1, -1))));
}
