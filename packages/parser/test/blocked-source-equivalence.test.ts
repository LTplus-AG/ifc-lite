/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A compressed source must be byte-indistinguishable from a resident one
 * (#2183).
 *
 * Sampling offsets would not establish that. The failure modes are all at
 * boundaries -- a read that starts one byte before a block edge, a multi-byte
 * UTF-8 sequence split across two blocks, a range clamped past the end -- so
 * this enumerates the FULL cross product of the interesting offsets rather
 * than picking a few. A few thousand pairs covers every code path class:
 * within-block, exact-boundary, straddling, multi-block, clamped and empty.
 *
 * Run at a tiny block size so boundaries are dense, AND once at the production
 * 64 KiB so the shipping configuration is the one that is actually asserted.
 */

import { describe, expect, it } from 'vitest';

import {
  contiguousSourceBytes,
  compressSourceInPlace,
  sourceBytesFromTransferable,
  type IfcSourceBytes,
} from '../src/source-bytes.js';
import { compressSource } from '../src/source-compress.js';
import { DEFAULT_BLOCK_SIZE } from '../src/block-store.js';

/**
 * A fixture with real multi-byte UTF-8, deliberately not aligned to any block
 * size, so sequences land across boundaries at every block size we test.
 *
 * ASCII-only content cannot catch a byte-vs-character offset bug, and STEP
 * files carry non-ASCII in names and descriptions constantly.
 */
function fixture(byteLength: number): Uint8Array {
  const unit = "#12=IFCWALL('0YvCT2_$X3',$,'Wand-Süd é€ \u{1F600}',$);\n";
  const bytes = new TextEncoder().encode(unit);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) out[i] = bytes[i % bytes.length];
  return out;
}

/** Every offset where behaviour can change, plus the wild ones. */
function criticalOffsets(len: number, blockSize: number): number[] {
  const s = new Set<number>([
    0, 1, 2, len - 1, len, len + 1, len + 7,
    -1, -5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
  ]);
  for (let b = 0; b <= Math.ceil(len / blockSize); b++) {
    const edge = b * blockSize;
    for (const d of [-2, -1, 0, 1, 2]) s.add(edge + d);
  }
  return [...s];
}

/**
 * Byte-wise comparison that does not allocate.
 *
 * `expect(Array.from(a)).toEqual(Array.from(b))` builds two JS arrays per
 * assertion; at the production block size the slices reach ~196 KB and the
 * suite times out before it asserts anything useful.
 */
function expectSameBytes(got: Uint8Array, want: Uint8Array, what: string): void {
  expect(got.byteLength, `${what} length`).toBe(want.byteLength);
  for (let i = 0; i < want.byteLength; i++) {
    if (got[i] !== want[i]) {
      expect.fail(`${what}: first difference at byte ${i}, got ${got[i]} want ${want[i]}`);
    }
  }
}

function compressed(bytes: Uint8Array, blockSize: number): IfcSourceBytes {
  const src = contiguousSourceBytes(bytes);
  const ok = compressSourceInPlace(src, compressSource(bytes, blockSize));
  if (!ok) throw new Error('compressSourceInPlace refused the payload');
  if (src.isResident) throw new Error('source did not switch to compressed storage');
  return src;
}

describe.each([
  { blockSize: 64, label: 'tiny blocks (dense boundaries)' },
  { blockSize: 1024, label: '1 KiB blocks' },
  { blockSize: DEFAULT_BLOCK_SIZE, label: 'production 64 KiB blocks' },
])('compressed source equivalence, $label', ({ blockSize }) => {
  // Several blocks plus an odd tail, so the short last block is always covered.
  const LEN = blockSize * 3 + 37;
  const bytes = fixture(LEN);
  const resident = contiguousSourceBytes(bytes);

  it('agrees with the resident source on EVERY critical offset pair', { timeout: 60_000 }, () => {
    const blocked = compressed(bytes, blockSize);
    const offsets = criticalOffsets(LEN, blockSize);
    let compares = 0;

    for (const start of offsets) {
      for (const end of offsets) {
        expectSameBytes(blocked.slice(start, end), resident.slice(start, end),
          `slice(${start}, ${end})`);
        expect(blocked.decodeUtf8(start, end), `decodeUtf8(${start}, ${end})`)
          .toBe(resident.decodeUtf8(start, end));
        compares++;
      }
    }

    // Guard against the whole loop being vacuous: if `offsets` ever collapsed
    // this would pass having asserted nothing.
    expect(compares).toBeGreaterThan(400);
  });

  it('decodes multi-byte sequences that straddle a block boundary', () => {
    const blocked = compressed(bytes, blockSize);
    // Walk a window across each boundary one byte at a time; a naive
    // per-block decode splits a code point somewhere in here.
    for (let b = 1; b * blockSize < LEN; b++) {
      const edge = b * blockSize;
      for (let d = -6; d <= 6; d++) {
        const start = Math.max(0, edge + d);
        const end = Math.min(LEN, start + 12);
        expect(blocked.decodeUtf8(start, end), `across boundary ${edge}, d=${d}`)
          .toBe(resident.decodeUtf8(start, end));
      }
    }
  });

  it('materializes back to the exact original bytes', () => {
    const blocked = compressed(bytes, blockSize);
    expectSameBytes(blocked.materialize(), bytes, 'materialize()');
    blocked.withMaterialized((b) => expectSameBytes(b, bytes, 'withMaterialized()'));
  });

  it('reports the same length and content key as the resident source', () => {
    const blocked = compressed(bytes, blockSize);
    expect(blocked.byteLength).toBe(LEN);
    expect(blocked.length).toBe(LEN);
    expect(blocked.contentKey).toBe(resident.contentKey);
  });

  it('survives a round trip through the transfer envelope', () => {
    const blocked = compressed(bytes, blockSize);
    const transfer = blocked.toTransferable();
    expect(transfer.kind).toBe('blocked');

    const back = sourceBytesFromTransferable(transfer);
    expect(back.byteLength).toBe(LEN);
    expect(back.contentKey).toBe(resident.contentKey);
    expectSameBytes(back.materialize(), bytes, 'rebuilt materialize()');
    for (const [s, e] of [[0, 10], [blockSize - 3, blockSize + 3], [LEN - 5, LEN]] as const) {
      expect(back.decodeUtf8(s, e)).toBe(resident.decodeUtf8(s, e));
    }
  });
});

describe('incompressible content', () => {
  it('never stores more than the original, and still reads back exactly', () => {
    // Deterministic pseudo-random bytes: deflate cannot shrink these, so every
    // block takes the stored-verbatim path. Without that path a source could
    // compress to LARGER than it started, which would make gating on size a
    // lie.
    // xorshift32, taking all four bytes of each word: an LCG's low byte is
    // far too regular and deflate shrinks it, which silently skips the
    // stored-verbatim path this test exists to cover.
    const LEN = 8192;
    const bytes = new Uint8Array(LEN);
    let x = 0x9e3779b9;
    for (let i = 0; i < LEN; i += 4) {
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      bytes[i] = x & 0xff;
      if (i + 1 < LEN) bytes[i + 1] = (x >>> 8) & 0xff;
      if (i + 2 < LEN) bytes[i + 2] = (x >>> 16) & 0xff;
      if (i + 3 < LEN) bytes[i + 3] = (x >>> 24) & 0xff;
    }

    const payload = compressSource(bytes, 1024);
    expect(payload.storedMask.some((f) => f === 1)).toBe(true);
    expect(payload.blocks.byteLength).toBeLessThanOrEqual(LEN);

    const resident = contiguousSourceBytes(bytes);
    const blocked = compressed(bytes, 1024);
    expectSameBytes(blocked.materialize(), bytes, 'materialize()');
    expectSameBytes(blocked.slice(1020, 1030), resident.slice(1020, 1030), 'slice across boundary');
  });
});
