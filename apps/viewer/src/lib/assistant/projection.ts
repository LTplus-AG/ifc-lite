/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Rows any adapter may include in one snapshot; native totals stay independent of it. */
export const ROW_LIMIT = 100;
export const TEXT_LIMIT = 48_000;

/** Explicitly bounded projection. No source buffers, stores, typed arrays or credentials. */
export function evidenceJson(value: unknown): { text: string; truncated: boolean } {
  let remaining = 1800;
  let truncated = false;
  const seen = new Set<object>();
  function project(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 8) { truncated = true; return '[omitted: evidence limit]'; }
    if (typeof item === 'string') {
      if (item.length > 1200) truncated = true;
      return item.slice(0, 1200);
    }
    if (typeof item === 'number') {
      if (Number.isFinite(item)) return item;
      truncated = true;
      return '[omitted: non-finite number]';
    }
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'bigint') return String(item);
    if (item instanceof Date) {
      if (Number.isFinite(item.getTime())) return item.toISOString();
      truncated = true;
      return '[omitted: invalid date]';
    }
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) { truncated = true; return undefined; }
    if (typeof item !== 'object') return undefined;
    if (seen.has(item)) { truncated = true; return '[omitted: repeated reference]'; }
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 100) truncated = true;
      return item.slice(0, 100).map(child => project(child, depth + 1));
    }
    if (Object.getPrototypeOf(item) !== Object.prototype) { truncated = true; return '[omitted: unsupported object]'; }
    const entries = Object.entries(item);
    if (entries.length > 64) truncated = true;
    return Object.fromEntries(entries.slice(0, 64).map(([key, child]) => [key, project(child, depth + 1)]));
  }
  const projected = project(value, 0);
  const text = JSON.stringify(projected);
  // Keep valid JSON: never cut a serialization in the middle of a value.
  if (!text || text.length > TEXT_LIMIT) return { text: JSON.stringify({ omitted: 'Evidence exceeded text budget' }), truncated: true };
  return { text, truncated };
}
