/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Synthesize `EntityRef[]` from a pre-built entity index (ids/starts/lengths
 * column arrays produced by the streaming geometry pre-pass) WITHOUT a
 * second WASM scan of the source.
 *
 * The pre-pass already walked the file once and emitted these three column
 * arrays; the parser worker reuses them so its own `scanEntitiesFastBytes`
 * call — which on a 986 MB / 14 M-entity file takes ~10 s under WASM
 * contention with the geometry workers — can be skipped entirely.
 *
 * Cost: ~1–2 s for 14 M entities. Almost all of it is the per-entity type
 * extraction (find `=`, find `(`, intern). Type interning hits ~99.99 % on
 * real IFC files (≈776 unique type names across 14 M entities) so we
 * allocate one JS string per unique type.
 */

import type { EntityRef } from './types.js';

const EQ = 0x3d;
const LPAREN = 0x28;
const SPACE = 0x20;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;

function bytesToAsciiKey(bytes: Uint8Array, start: number, end: number): string {
  // String.fromCharCode loop is the fastest portable way to build a short
  // ASCII string from a byte range without allocating an intermediate
  // typed-array slice. Type names are ≤ ~30 chars so the loop is tight.
  let s = '';
  for (let i = start; i < end; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

export function buildEntityRefsFromIndex(
  source: Uint8Array,
  ids: Uint32Array,
  starts: Uint32Array,
  lengths: Uint32Array,
): EntityRef[] {
  const n = ids.length;
  const refs: EntityRef[] = new Array(n);
  const intern = new Map<string, string>();
  const sourceLen = source.length;

  // The columns arrive in HashMap-iteration order from the Rust pre-pass
  // (random). Downstream `buildCompactEntityIndexAsync` checks whether
  // expressIds are ascending and pays an O(N log N) object sort if not
  // — on 14 M entries that's ~8 s. Pre-sort an index permutation (typed
  // array sort with comparator is ~1 s) so refs come out ID-ordered and
  // the downstream check passes cheaply. Same end state, cost paid here
  // once instead of as a slower object sort later.
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  order.sort((a, b) => ids[a] - ids[b]);

  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const start = starts[i];
    const len = lengths[i];
    const limit = start + len <= sourceLen ? start + len : sourceLen;

    // Skip past `#<digits>=` to find the type token.
    let p = start;
    while (p < limit && source[p] !== EQ) p++;
    p++;
    while (p < limit && (source[p] === SPACE || source[p] === TAB)) p++;
    const typeStart = p;
    while (
      p < limit
      && source[p] !== LPAREN
      && source[p] !== SPACE
      && source[p] !== TAB
      && source[p] !== LF
      && source[p] !== CR
    ) p++;
    const typeEnd = p;

    const key = bytesToAsciiKey(source, typeStart, typeEnd);
    let interned = intern.get(key);
    if (interned === undefined) {
      intern.set(key, key);
      interned = key;
    }

    refs[oi] = {
      expressId: ids[i],
      type: interned,
      byteOffset: start,
      byteLength: len,
      // Line numbers aren't computed here — the columnar parser only uses
      // them in diagnostic output. Skipping the newline-counting pass saves
      // ~500 ms on 14 M entities. Set to 0 as a sentinel "unknown".
      lineNumber: 0,
    };
  }

  return refs;
}
