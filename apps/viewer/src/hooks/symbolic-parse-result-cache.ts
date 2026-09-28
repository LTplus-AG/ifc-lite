/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ParseResult } from '../lib/overlay-parse/symbolic-parse.js';

// Bucketed results can be large. The byte-derived flat cache lets an evicted
// result be rebuilt cheaply, so retain only the 32 most recently completed
// frame / hierarchy variants across all stores.
export const MAX_PARSE_RESULTS = 32;
export const PARSE_CACHE = new Map<string, ParseResult>();
export const PARSE_INFLIGHT = new Map<string, Promise<void>>();

export function cacheParseResult(key: string, result: ParseResult): void {
  PARSE_CACHE.delete(key);
  PARSE_CACHE.set(key, result);
  while (PARSE_CACHE.size > MAX_PARSE_RESULTS) {
    const oldest = PARSE_CACHE.keys().next().value;
    if (oldest === undefined) break;
    PARSE_CACHE.delete(oldest);
  }
}

export function cacheRoomParseResult(entries: Map<string, ParseResult>, key: string, result: ParseResult): void {
  entries.delete(key);
  entries.set(key, result);
  while (entries.size > MAX_PARSE_RESULTS) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/** @internal test-only count for verifying the retained-result bound. */
export function __parseResultCacheSizeForTests(): number {
  return PARSE_CACHE.size;
}
