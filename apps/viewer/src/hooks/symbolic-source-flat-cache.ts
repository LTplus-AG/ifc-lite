/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { FlatSymbolic } from '../lib/overlay-parse/symbolic-flat.js';
import { MAX_PARSE_RESULTS } from './symbolic-parse-result-cache.js';

const SOURCE_FLAT_CACHE = new Map<string, FlatSymbolic>();
const SOURCE_FLAT_INFLIGHT = new Map<string, Promise<FlatSymbolic>>();

export function getSourceFlat(key: string, load: () => Promise<FlatSymbolic>): Promise<FlatSymbolic> {
  const cached = SOURCE_FLAT_CACHE.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = SOURCE_FLAT_INFLIGHT.get(key);
  if (pending) return pending;
  const promise = load()
    .then((flat) => {
      SOURCE_FLAT_CACHE.delete(key);
      SOURCE_FLAT_CACHE.set(key, flat);
      while (SOURCE_FLAT_CACHE.size > MAX_PARSE_RESULTS) {
        const oldest = SOURCE_FLAT_CACHE.keys().next().value;
        if (oldest === undefined) break;
        SOURCE_FLAT_CACHE.delete(oldest);
      }
      return flat;
    })
    .finally(() => SOURCE_FLAT_INFLIGHT.delete(key));
  SOURCE_FLAT_INFLIGHT.set(key, promise);
  return promise;
}

/** @internal test-only count for verifying the retained flat-output bound. */
export function __sourceFlatCacheSizeForTests(): number {
  return SOURCE_FLAT_CACHE.size;
}

export function clearSourceFlatCache(): void {
  SOURCE_FLAT_CACHE.clear();
  SOURCE_FLAT_INFLIGHT.clear();
}
