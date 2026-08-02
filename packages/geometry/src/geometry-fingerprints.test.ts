/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  extractGeometryFingerprints,
  geometryAabbAt,
  writeGeometryAabbAt,
  type GeometryFingerprintSource,
} from './geometry-fingerprints.js';

/** A source with `n` hashed ids and, optionally, their boxes. */
function source(
  ids: number[],
  hashes: bigint[],
  aabbValues?: number[],
): GeometryFingerprintSource {
  return {
    geometryHashCount: ids.length,
    geometryHashIds: new Uint32Array(ids),
    geometryHashValues: new BigUint64Array(hashes),
    ...(aabbValues ? { geometryAabbValues: new Float64Array(aabbValues) } : {}),
  };
}

describe('extractGeometryFingerprints', () => {
  it('pairs each id with the box at ITS index, not the first one', () => {
    // Three entities with three distinguishable boxes. A stride bug (reading
    // [i, i+6) instead of [6i, 6i+6)) still returns a box for every id, so the
    // only thing that catches it is checking that id 20 got box #2 and not a
    // slice straddling boxes #0 and #1.
    const fingerprints = extractGeometryFingerprints(
      source(
        [10, 20, 30],
        [1n, 2n, 3n],
        [
          0, 0, 0, 1, 1, 1,
          10, 10, 10, 11, 11, 11,
          20, 20, 20, 21, 21, 21,
        ],
      ),
    );

    expect(fingerprints.size).toBe(3);
    expect(fingerprints.get(10)).toEqual({ hash: 1n, aabb: { min: [0, 0, 0], max: [1, 1, 1] } });
    expect(fingerprints.get(20)).toEqual({
      hash: 2n,
      aabb: { min: [10, 10, 10], max: [11, 11, 11] },
    });
    expect(fingerprints.get(30)).toEqual({
      hash: 3n,
      aabb: { min: [20, 20, 20], max: [21, 21, 21] },
    });
  });

  it('drops the NaN sentinel span without shifting the boxes after it', () => {
    // The wasm side reserves six NaNs for an entity it could not box, precisely
    // so the array stays index-parallel. The absent box must become `undefined`
    // (the diff engine's contract) AND id 30 must still get ITS box.
    const fingerprints = extractGeometryFingerprints(
      source(
        [10, 20, 30],
        [1n, 2n, 3n],
        [
          0, 0, 0, 1, 1, 1,
          NaN, NaN, NaN, NaN, NaN, NaN,
          20, 20, 20, 21, 21, 21,
        ],
      ),
    );

    expect(fingerprints.get(20)).toEqual({ hash: 2n });
    expect(fingerprints.get(20)!.aabb).toBeUndefined();
    expect(fingerprints.get(30)!.aabb).toEqual({ min: [20, 20, 20], max: [21, 21, 21] });
  });

  it('rejects a half-NaN box rather than passing a partly-real one on', () => {
    // Half a box is not a usable box: `isUsableAabb` in @ifc-lite/diff would
    // reject it anyway, and a centre computed from it is meaningless.
    const fingerprints = extractGeometryFingerprints(
      source([10], [1n], [0, 0, NaN, 1, 1, 1]),
    );
    expect(fingerprints.get(10)).toEqual({ hash: 1n });
  });

  it('still yields hashes on a wasm build with no geometryAabbValues getter', () => {
    // The #1988-predating build. Degrading to today's behaviour (hashes, no
    // boxes, bare `moved`) is the requirement; throwing is not.
    const fingerprints = extractGeometryFingerprints(source([10, 20], [7n, 8n]));
    expect(fingerprints.get(10)).toEqual({ hash: 7n });
    expect(fingerprints.get(20)).toEqual({ hash: 8n });
  });

  it('stops at the shorter of the id and hash arrays', () => {
    // The wasm contract says the two are the same length, so this can only fire
    // on a malformed source - but the alternative to the guard is `values[2]`
    // reading `undefined` and being stored as an entity's `hash: bigint`, which
    // is a lie the type system cannot catch and the diff would act on.
    const fingerprints = extractGeometryFingerprints({
      geometryHashCount: 3,
      geometryHashIds: new Uint32Array([10, 20, 30]),
      geometryHashValues: new BigUint64Array([1n, 2n]),
    });
    expect([...fingerprints.keys()]).toEqual([10, 20]);
    expect(fingerprints.has(30)).toBe(false);
  });

  it('is empty when hashing is off', () => {
    expect(extractGeometryFingerprints({ geometryHashCount: 0 }).size).toBe(0);
    expect(extractGeometryFingerprints({}).size).toBe(0);
  });

  it('reads no copy-to-JS getter when hashing is off', () => {
    // Each of these is a wasm→JS array COPY, and this runs once per batch on
    // every load — including the overwhelming majority with the diff feature
    // off. The count check exists to make those three reads never happen.
    const touched: string[] = [];
    const spy: GeometryFingerprintSource = { geometryHashCount: 0 };
    for (const name of ['geometryHashIds', 'geometryHashValues', 'geometryAabbValues']) {
      Object.defineProperty(spy, name, {
        get() {
          touched.push(name);
          return undefined;
        },
      });
    }

    expect(extractGeometryFingerprints(spy).size).toBe(0);
    expect(touched).toEqual([]);
  });

  it('does not invent a box from an array too short for the last entry', () => {
    // A truncated transfer must not read past the end and hand back a box of
    // `undefined`s that `Number.isFinite` never got to veto.
    const fingerprints = extractGeometryFingerprints(
      source([10, 20], [1n, 2n], [0, 0, 0, 1, 1, 1, 9, 9, 9]),
    );
    expect(fingerprints.get(10)!.aabb).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(fingerprints.get(20)).toEqual({ hash: 2n });
  });
});

describe('geometryAabbAt', () => {
  it('reads min from the first three values and max from the next three', () => {
    // Not symmetric: min and max are distinguishable, so a swapped read fails.
    expect(geometryAabbAt(new Float64Array([1, 2, 3, 4, 5, 6]), 0)).toEqual({
      min: [1, 2, 3],
      max: [4, 5, 6],
    });
  });

  it('returns undefined for an absent array', () => {
    expect(geometryAabbAt(undefined, 0)).toBeUndefined();
  });

  it('returns undefined past the end rather than a box of undefineds', () => {
    // Out-of-range typed-array reads are `undefined`, and the single finite
    // guard rejects them - the same guard that rejects the NaN sentinel.
    expect(geometryAabbAt(new Float64Array([1, 2, 3, 4, 5, 6]), 1)).toBeUndefined();
  });
});

describe('writeGeometryAabbAt', () => {
  it('round-trips through geometryAabbAt at a non-zero index', () => {
    // This is the ONLY thing tying the geometry worker's encoder to the main
    // thread's decoder for the instanced-only side-channel. Index 2 (not 0) and
    // an asymmetric box are both load-bearing: a stride bug or a min/max swap
    // is invisible at index 0 with a symmetric box.
    const values = new Float64Array(3 * 6).fill(NaN);
    const aabb = { min: [1, 2, 3] as [number, number, number], max: [4, 5, 6] as [number, number, number] };
    writeGeometryAabbAt(values, 2, aabb);

    expect(geometryAabbAt(values, 2)).toEqual(aabb);
    // The untouched neighbours must still read as absent, not as the smeared
    // remains of the write.
    expect(geometryAabbAt(values, 0)).toBeUndefined();
    expect(geometryAabbAt(values, 1)).toBeUndefined();
  });
});
