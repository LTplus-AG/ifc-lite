/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Largest serialized operation result the executor returns, in UTF-8 bytes. A leaf module so operation families can import it. */
export const MAX_RESULT_BYTES = 1_000_000;

/** Room a paged result keeps for its keys, page fields and wrapper. */
const PAGE_RESERVE = 16 * 1024;

const utf8 = new TextEncoder();

/** UTF-8 bytes of `text`. */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/** UTF-8 bytes of `value`'s JSON: what the executor measures against {@link MAX_RESULT_BYTES}. */
export function resultBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value) ?? 'null');
}

/**
 * UTF-8 bytes `value` costs inside a `native_json` string, where the executor measures it: its JSON, escaped again.
 */
function nativeJsonBytes(value: unknown): number {
  return resultBytes(JSON.stringify(value) ?? 'null') - 2;
}

/** One page of a list, and where the next page starts (null on the last). */
export interface Page<T> {
  items: T[];
  offset: number;
  total: number;
  next_offset: number | null;
}

/**
 * The longest run of `items` from `from` (default 0) that fits the result limit beside `rest`, the other fields of the
 * same result (#10794). Callers page with `next_offset` until it is null. An item too large for any page is refused,
 * never skipped.
 */
export function boundedPage<T>(items: readonly T[], from?: number | null, rest: unknown = null): Page<T> {
  const offset = from ?? 0, budget = MAX_RESULT_BYTES - PAGE_RESERVE - nativeJsonBytes(rest);
  if (budget <= 2) throw new Error('The fields beside this list already exceed the operation result limit.');
  let used = 2, end = Math.min(offset, items.length);
  for (; end < items.length; end++) {
    const size = nativeJsonBytes(items[end]) + (end > offset ? 1 : 0);
    if (used + size > budget) break;
    used += size;
  }
  if (end === offset && offset < items.length) throw new Error(`Item ${offset} alone exceeds the operation result limit; read on from offset ${offset + 1}.`);
  return { items: items.slice(offset, end), offset, total: items.length, next_offset: end < items.length ? end : null };
}

/** The optional `offset` input of a paged read. */
export type PageInput = { offset?: number | null };
export const pageInput = {
  type: 'object' as const,
  properties: { offset: { type: 'integer' as const, minimum: 0, nullable: true as const } },
  required: [] as const,
  additionalProperties: false as const,
};
