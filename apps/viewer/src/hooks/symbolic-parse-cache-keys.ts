/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { OverlayRtcContext } from '../lib/overlay-parse/rtc-context.js';

/** Stable value key for the live lookups used by buildParseResult's buckets. */
export function spatialBucketKey(
  elementToStorey: ReadonlyMap<number, number> | undefined,
  storeyElevations: ReadonlyMap<number, number> | undefined,
): string {
  // Keep cache keys bounded even for large models. This mirrors the source's
  // contentKey contract: a stable 64-bit digest of every lookup pair.
  let hash = 0xcbf29ce484222325n;
  const feed = (value: string): void => {
    for (let i = 0; i < value.length; i++) {
      hash ^= BigInt(value.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  };
  const pairs = (map: ReadonlyMap<number, number> | undefined): void => {
    if (!map) { feed('-;'); return; }
    // Sort so equivalent maps produce the same key independent of insertion
    // order. Delimiters make the two maps and numeric pairs unambiguous.
    for (const [id, value] of [...map].sort(([a], [b]) => a - b)) feed(`${id}:${value},`);
    feed(';');
  };
  pairs(elementToStorey);
  pairs(storeyElevations);
  return hash.toString(16).padStart(16, '0');
}

export function sourceFlatKey(
  store: IfcDataStore,
  rtc: Exclude<OverlayRtcContext, { mode: 'pending' }>,
): string | null {
  const source = store.source;
  return source?.contentKey ? `${source.contentKey}|${rtc.key}` : null;
}
