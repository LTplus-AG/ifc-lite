/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ToolErrorCode, ToolExecutionError } from '@ifc-lite/mcp/browser';
import { stateRevision } from './state-revision';

/** Largest serialized operation result the executor returns, in UTF-8 bytes. Used by the executor and operation families. */
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

/** One page of a list, where the next page starts (null on the last), and the revision of the whole list it came from. */
export interface Page<T> {
  items: T[];
  offset: number;
  total: number;
  next_offset: number | null;
  /** Digest of every item of the list, not just this page; the next page must send it back as `page_revision`. */
  page_revision: string;
}

/** Where a paged read starts: an offset, and past offset 0 the `page_revision` of the page before it. */
export interface PageRequest { offset?: number | null; page_revision?: string | null; limit?: number | null }

/**
 * The longest run of `items` from `request.offset` (default 0) that fits the row limit and result limit beside `rest`, the other
 * fields of the same result (#10794). Callers page with `next_offset` until it is null.
 *
 * An offset is only meaningful against the list it was computed from: a removal before it would skip a row, an
 * insertion would repeat one. So every page carries `page_revision`, a digest of the whole list (pass `revision` when
 * the caller already has one), and a read past offset 0 is refused unless it sends back the previous page's
 * revision unchanged. A changed list is refused with "read again from offset 0", never paged past silently.
 * An item too large for any page is refused, never skipped.
 */
export function boundedPage<T>(items: readonly T[], request: PageRequest = {}, rest: unknown = null, revision = stateRevision(items)): Page<T> {
  return boundedMappedPage(items, item => item, request, rest, revision);
}

/** Project and measure only rows on this page. Pass a revision of the whole source and its projection inputs. */
export function boundedMappedPage<T, R>(items: readonly T[], project: (item: T, index: number) => R,
  request: PageRequest, rest: unknown, revision: string): Page<R> {
  const offset = request.offset ?? 0;
  requirePageRevision(offset, request.page_revision, revision);
  const budget = MAX_RESULT_BYTES - PAGE_RESERVE - nativeJsonBytes(rest);
  if (budget <= 2) throw new Error('The fields beside this list already exceed the operation result limit.');
  let used = 2, end = Math.min(offset, items.length);
  const stop = Math.min(items.length, offset + (request.limit ?? items.length));
  const page: R[] = [];
  for (; end < stop; end++) {
    const row = project(items[end], end);
    const size = nativeJsonBytes(row) + (end > offset ? 1 : 0);
    if (used + size > budget) break;
    used += size;
    page.push(row);
  }
  if (end === offset && offset < items.length) throw new Error(`Item ${offset} alone exceeds the operation result limit; read on from offset ${offset + 1} with page_revision ${revision}.`);
  return { items: page, offset, total: items.length, next_offset: end < items.length ? end : null, page_revision: revision };
}

export function requirePageRevision(offset: number, supplied: string | null | undefined, revision: string): void {
  if (offset === 0) return;
  if (!supplied) throw new ToolExecutionError({ code: ToolErrorCode.INVALID_INPUT, details: { reason: 'invalid-value' },
    message: 'page_revision is required past offset 0: pass the page_revision of the previous page.' });
  if (supplied !== revision) throw new ToolExecutionError({ code: ToolErrorCode.STATE_CHANGED, details: { reason: 'stale' },
    message: 'The list changed since the previous page; read again from offset 0.' });
}

/** The input of a paged read: an optional `offset`, and past offset 0 the previous page's `page_revision`. */
export type PageInput = Omit<PageRequest, 'limit'>;
export const pageOutputProperties = {
  next_offset: { type: ['integer', 'null'] },
  page_revision: { type: 'string' },
};
export const pageInput = {
  type: 'object' as const,
  properties: { offset: { type: 'integer' as const, minimum: 0, nullable: true as const }, page_revision: { type: 'string' as const, maxLength: 64, nullable: true as const } },
  required: [] as const,
  additionalProperties: false as const,
};
