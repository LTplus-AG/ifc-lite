/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { safeUtf8Decode } from '@ifc-lite/data';

import {
  asSourceBytes,
  contiguousSourceBytes,
  EMPTY_SOURCE_BYTES,
  isSourceBytes,
  sourceBytesFromTransferable,
  type IfcSourceBytes,
} from './source-bytes.js';

const STEP = "#42=IFCWALL('0YvCT2_$X3_xJG3rzD8L_8',$,'Wall-A',$);\n#43=IFCSLAB('1abCT2',$);\n";

/** Real UTF-8 bytes. `charCodeAt` would write UTF-16 code units and make the
 *  whole suite ASCII-only, which cannot catch a byte-vs-char offset bug. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('ContiguousSourceBytes', () => {
  it('is zero-copy: slice returns a VIEW, not a copy', () => {
    const view = bytes(STEP);
    const got = contiguousSourceBytes(view).slice(0, 5);
    // A copy here would be a silent perf regression on the hottest read path.
    expect(got.buffer).toBe(view.buffer);
    expect(got.byteOffset).toBe(0);
    expect(got.byteLength).toBe(5);
  });

  it('decodes a range identically to the helper every caller uses today', () => {
    const view = bytes(STEP);
    const src = contiguousSourceBytes(view);
    for (const [s, e] of [[0, STEP.length], [0, 5], [10, 30], [42, 43]] as const) {
      expect(src.decodeUtf8(s, e)).toBe(safeUtf8Decode(view, s, e));
    }
  });

  it('clamps wild ranges instead of throwing', () => {
    const src = contiguousSourceBytes(bytes('abcdef'));
    expect(src.decodeUtf8(-5, 3)).toBe('abc');
    expect(src.decodeUtf8(3, 999)).toBe('def');
    expect(src.decodeUtf8(4, 2)).toBe('');
    expect(src.decodeUtf8(99, 200)).toBe('');
    expect(src.decodeUtf8(NaN, 3)).toBe('abc');
    expect(src.slice(2, 2).byteLength).toBe(0);
  });

  // Byte offsets, not character offsets. STEP files carry non-ASCII in names
  // and descriptions constantly, and an offset bug there is invisible to an
  // ASCII fixture.
  it('decodes multibyte content at BYTE offsets', () => {
    const text = 'AéB\u20acC';           // A | c3 a9 | B | e2 82 ac | C
    const view = bytes(text);
    const src = contiguousSourceBytes(view);
    expect(view.byteLength).toBe(8);
    expect(src.byteLength).toBe(8);
    expect(src.decodeUtf8(1, 3)).toBe('é');
    expect(src.decodeUtf8(4, 7)).toBe('\u20ac');
    expect(src.decodeUtf8(0, 8)).toBe(text);
    expect(src.slice(1, 3).byteLength).toBe(2);
  });

  it('materialize hands back the whole source', () => {
    const view = bytes(STEP);
    const src = contiguousSourceBytes(view);
    expect(src.materialize().byteLength).toBe(view.byteLength);
    expect(src.withMaterialized((b) => b.byteLength)).toBe(view.byteLength);
  });

  it('round-trips through toTransferable', () => {
    const src = contiguousSourceBytes(bytes(STEP));
    const back = sourceBytesFromTransferable(src.toTransferable());
    expect(back.byteLength).toBe(src.byteLength);
    expect(back.decodeUtf8(0, 12)).toBe(src.decodeUtf8(0, 12));
    // The key must survive the hop, or every downstream cache invalidates.
    expect(back.contentKey).toBe(src.contentKey);
  });
});

describe('contentKey', () => {
  it('is stable for the same bytes and differs for different bytes', () => {
    const a = contiguousSourceBytes(bytes(STEP));
    const b = contiguousSourceBytes(bytes(STEP));
    const c = contiguousSourceBytes(bytes(`${STEP}#44=IFCBEAM($);`));
    expect(a.contentKey).toBe(b.contentKey);
    expect(a.contentKey).not.toBe(c.contentKey);
  });

  // The bug this replaces: useDrawingGeneration keyed a cache on byteLength
  // alone, so two same-size models shared one cache entry.
  it('differs for SAME-LENGTH different content', () => {
    const a = contiguousSourceBytes(bytes('AAAAAAAAAAAA'));
    const b = contiguousSourceBytes(bytes('AAAAAAAAAAAB'));
    expect(a.byteLength).toBe(b.byteLength);
    expect(a.contentKey).not.toBe(b.contentKey);
  });

  it('is null when there is no source', () => {
    expect(EMPTY_SOURCE_BYTES.contentKey).toBe(null);
    expect(contiguousSourceBytes(new Uint8Array(0)).contentKey).toBe(null);
  });
});

/**
 * THE table this commit exists to protect.
 *
 * ~79 sites guard on the source with one of these shapes, and two are semantic
 * discriminators rather than defensive noise: `ids/bridge/properties` uses
 * source-presence to mean "WASM store, not server store", and
 * `material-resolver` uses it to decide cache safety. If any row diverges
 * between a zero-length Uint8Array and EMPTY_SOURCE_BYTES, those sites change
 * meaning silently the moment the field type flips.
 */
describe('degraded-mode guard equivalence', () => {
  type Guarded = { length: number; byteLength: number } | null | undefined;
  const guards: [string, (s: Guarded) => unknown][] = [
    ['!s?.length', (s) => !s?.length],
    ['!!s && s.length > 0', (s) => !!s && s.length > 0],
    ['s?.byteLength ?? 0', (s) => s?.byteLength ?? 0],
    ['!s', (s) => !s],
    ['s && s.byteLength > 0', (s) => Boolean(s && s.byteLength > 0)],
    ['!s || s.length === 0', (s) => !s || s.length === 0],
    ['(s?.byteLength ?? 0) > 0', (s) => (s?.byteLength ?? 0) > 0],
    ['Boolean(s?.byteLength)', (s) => Boolean(s?.byteLength)],
  ];

  it('agrees between an empty Uint8Array and EMPTY_SOURCE_BYTES', () => {
    const legacy = new Uint8Array(0);
    for (const [label, guard] of guards) {
      expect(guard(EMPTY_SOURCE_BYTES), `guard "${label}"`).toStrictEqual(guard(legacy));
    }
  });

  it('agrees for a NON-empty source too', () => {
    const view = bytes(STEP);
    const wrapped = contiguousSourceBytes(view);
    for (const [label, guard] of guards) {
      expect(guard(wrapped), `guard "${label}"`).toStrictEqual(guard(view));
    }
  });

  it('empty sources hand out a FRESH buffer each call', () => {
    // A shared mutable empty would couple unrelated callers.
    expect(EMPTY_SOURCE_BYTES.materialize()).not.toBe(EMPTY_SOURCE_BYTES.materialize());
    expect(EMPTY_SOURCE_BYTES.slice(0, 10).byteLength).toBe(0);
    expect(EMPTY_SOURCE_BYTES.decodeUtf8(0, 10)).toBe('');
  });

  it('an empty or missing view collapses to the shared empty', () => {
    expect(contiguousSourceBytes(new Uint8Array(0))).toBe(EMPTY_SOURCE_BYTES);
    expect(contiguousSourceBytes(null)).toBe(EMPTY_SOURCE_BYTES);
    expect(contiguousSourceBytes(undefined)).toBe(EMPTY_SOURCE_BYTES);
  });
});

describe('narrowing helpers', () => {
  it('isSourceBytes distinguishes the accessor from a raw buffer', () => {
    expect(isSourceBytes(contiguousSourceBytes(bytes(STEP)))).toBe(true);
    expect(isSourceBytes(EMPTY_SOURCE_BYTES)).toBe(true);
    expect(isSourceBytes(bytes(STEP))).toBe(false);
    expect(isSourceBytes(null)).toBe(false);
    expect(isSourceBytes({})).toBe(false);
  });

  it('rejects a partially-shaped duck', () => {
    // The old predicate accepted anything with slice/decodeUtf8/byteLength,
    // so asSourceBytes handed it straight back and materialize() threw later.
    const duck = { byteLength: 3, length: 3, slice: () => new Uint8Array(0), decodeUtf8: () => '' };
    expect(isSourceBytes(duck)).toBe(false);
  });

  it('does NOT compute contentKey while narrowing', () => {
    // contentKey hashes the whole file; asSourceBytes runs in the
    // EntityExtractor constructor, so probing it here would be a full-file
    // scan per construction.
    let probed = false;
    const spy = {
      byteLength: 0, length: 0, isResident: true,
      get contentKey() { probed = true; return null; },
      slice: () => new Uint8Array(0),
      decodeUtf8: () => '',
      materialize: () => new Uint8Array(0),
      withMaterialized: (f: (b: Uint8Array) => unknown) => f(new Uint8Array(0)),
      withMaterializedAsync: async (f: (b: Uint8Array) => Promise<unknown>) => f(new Uint8Array(0)),
      toTransferable: () => ({ kind: 'contiguous' as const, bytes: new Uint8Array(0), contentKey: null }),
    };
    expect(isSourceBytes(spy)).toBe(true);
    expect(probed).toBe(false);
  });

  it('asSourceBytes accepts both shapes and is idempotent', () => {
    const view = bytes(STEP);
    expect(asSourceBytes(view).decodeUtf8(0, 8)).toBe(safeUtf8Decode(view, 0, 8));
    const already: IfcSourceBytes = contiguousSourceBytes(view);
    expect(asSourceBytes(already)).toBe(already);
  });
});
