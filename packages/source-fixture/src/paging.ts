/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Page } from '@ifc-lite/plugin-api';

import { FixtureApiError } from './errors.js';

/**
 * Deterministic (non-cryptographic) string hash — FNV-1a. Used to bind a
 * cursor to the query that produced it without pulling in a hashing
 * dependency, so this package stays limited to `@ifc-lite/plugin-api`.
 */
function hashContext(contextKey: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < contextKey.length; i++) {
    h ^= contextKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * Encodes an offset together with a hash of the query that produced it, so a
 * cursor minted for one query can never be silently reused against another —
 * matching `Page`'s contract that a cursor is opaque and not meant to
 * outlive the call that returned it. `contextKey` should fold in every
 * parameter that changes what "page N" means (project/container id, filter,
 * search query, ...).
 */
function encodeCursor(contextKey: string, offset: number): string {
  return `${hashContext(contextKey)}.${offset}`;
}

/** Inverse of {@link encodeCursor}. Throws on a malformed or foreign cursor. */
function decodeCursor(contextKey: string, cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^([0-9a-f]+)\.(\d+)$/.exec(cursor);
  if (!match) {
    throw new FixtureApiError(`Malformed cursor: ${JSON.stringify(cursor)}`, 400);
  }
  const [, hash, offsetStr] = match;
  if (hash !== hashContext(contextKey)) {
    throw new FixtureApiError('Cursor does not belong to this query', 400);
  }
  return Number(offsetStr);
}

/** Options every listing call accepts, reduced to what pagination needs. */
export interface PageRequest {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * Slices `items` into one page. `contextKey` must uniquely identify the
 * query (method + every parameter that affects the result set) so cursors
 * cannot cross queries. `maxPageSize` is the fixture's configured server-side
 * cap — `limit` is only ever a hint that gets clamped down to it, never
 * expanded past it, matching the real contract ("Hint only; providers clamp
 * to whatever their API allows").
 */
export function paginate<T>(
  items: readonly T[],
  contextKey: string,
  request: PageRequest | undefined,
  maxPageSize: number,
): Page<T> {
  const offset = decodeCursor(contextKey, request?.cursor);
  const requested = request?.limit && request.limit > 0 ? Math.floor(request.limit) : maxPageSize;
  const size = Math.max(1, Math.min(requested, maxPageSize));
  const slice = items.slice(offset, offset + size);
  const nextOffset = offset + slice.length;
  const cursor = nextOffset < items.length ? encodeCursor(contextKey, nextOffset) : undefined;
  return { items: slice, cursor };
}
