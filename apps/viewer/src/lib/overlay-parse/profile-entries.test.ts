/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import type { ProfileCollection } from '@ifc-lite/wasm';
import type { ProfileEntry } from '@ifc-lite/drawing-2d';
import { collectFlatProfiles } from './profiles-flat.js';
import { buildProfileEntries } from './profile-entries.js';

/**
 * Equivalence anchor for moving the construction-projection extraction into
 * the overlay worker (#2183).
 *
 * `useDrawingGeneration` used to call `extractProfiles` on the whole source on
 * the main thread and walk the collection inline, which regrew a ~470 MB
 * main-thread `WebAssembly.Memory` the first time a user enabled construction
 * projection. The walk now runs over the worker's flat arrays instead — and
 * "the projection still looks right" is not a proof: a hole ring sliced at the
 * wrong offset, a wrapped type index, or a transform read off a mis-strided
 * buffer all silently change which footprints get drawn where.
 *
 * So this pins the new implementation against a VERBATIM copy of the walk that
 * was deleted, run over the same fake collection. The two are independent
 * implementations; only real agreement passes.
 *
 * Every scalar the fake hands out is `Math.fround`ed and the arrays are typed,
 * because that is what a wasm-bindgen getter returns: f32 values widened to JS
 * numbers. Feeding the legacy walk f64s it could never have seen would make it
 * disagree with the (necessarily f32) flatten for reasons that have nothing to
 * do with this change.
 */

const f32 = Math.fround;

interface FakeEntry {
  expressId: number;
  ifcType: string;
  outerPoints: Float32Array;
  holeCounts: Uint32Array;
  holePoints: Float32Array;
  transform: Float32Array;
  extrusionDir: Float32Array;
  extrusionDepth: number;
  free(): void;
}

/** A 4×4 column-major transform with a recognisable translation column. */
function transformAt(tx: number, ty: number, tz: number): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    tx, ty, tz, 1,
  ];
}

function entry(fields: {
  expressId: number;
  ifcType: string;
  outerPoints: number[];
  holeCounts?: number[];
  holePoints?: number[];
  transform: number[];
  extrusionDir: number[];
  extrusionDepth: number;
}): FakeEntry {
  return {
    expressId: fields.expressId,
    ifcType: fields.ifcType,
    outerPoints: Float32Array.from(fields.outerPoints),
    holeCounts: Uint32Array.from(fields.holeCounts ?? []),
    holePoints: Float32Array.from(fields.holePoints ?? []),
    transform: Float32Array.from(fields.transform),
    extrusionDir: Float32Array.from(fields.extrusionDir),
    extrusionDepth: f32(fields.extrusionDepth),
    free() { /* handle release is asserted separately below */ },
  };
}

function makeCollection(entries: (FakeEntry | undefined)[]): ProfileCollection {
  return {
    length: entries.length,
    get: (i: number) => entries[i],
  } as unknown as ProfileCollection;
}

/**
 * The walk exactly as it stood in `useDrawingGeneration.ts` before #2183's
 * step 3 — `.slice()` copies, RTC subtraction, handle frees and all. Do not
 * "improve" it: its value is that it is the shipped behaviour.
 */
function legacyWalk(
  collection: ProfileCollection,
  shift: { x: number; y: number; z: number },
): ProfileEntry[] {
  const profiles: ProfileEntry[] = [];
  const c = collection as unknown as {
    length: number;
    get(i: number): FakeEntry | undefined;
  };
  const len = c.length;
  for (let i = 0; i < len; i++) {
    const e = c.get(i);
    if (!e) continue;
    try {
      const transform = e.transform.slice();
      transform[12] -= shift.x;
      transform[13] -= shift.y;
      transform[14] -= shift.z;
      profiles.push({
        expressId: e.expressId,
        ifcType: e.ifcType,
        outerPoints: e.outerPoints.slice(),
        holeCounts: e.holeCounts.slice(),
        holePoints: e.holePoints.slice(),
        transform,
        extrusionDir: e.extrusionDir.slice(),
        extrusionDepth: e.extrusionDepth,
        modelIndex: 0,
      });
    } finally {
      e.free();
    }
  }
  return profiles;
}

/**
 * Mixed set: a ringed profile with two holes, one with none, a gap in the
 * collection, and an express id past 2^24 (which a `Float32Array` id column
 * could not hold exactly).
 */
function fixture(): (FakeEntry | undefined)[] {
  return [
    entry({
      expressId: 101,
      ifcType: 'IfcWallStandardCase',
      outerPoints: [0, 0, 4, 0, 4, 3, 0, 3],
      holeCounts: [4, 3],
      holePoints: [1, 1, 2, 1, 2, 2, 1, 2, 3, 0.5, 3.5, 0.5, 3.25, 1],
      transform: transformAt(1200.5, 30.25, -800.125),
      extrusionDir: [0, 1, 0],
      extrusionDepth: 2.75,
    }),
    entry({
      expressId: 102,
      ifcType: 'IfcSlab',
      outerPoints: [0, 0, 10, 0, 10, 8, 0, 8],
      transform: transformAt(0, 0, 0),
      extrusionDir: [0, -1, 0],
      extrusionDepth: 0.2,
    }),
    // A gap: `ProfileCollection.get` returns undefined out of bounds, and the
    // walk must skip rather than emit a hole in the output.
    undefined,
    entry({
      expressId: 33_554_433, // 2^25 + 1: not representable exactly as f32
      ifcType: 'IfcBeam',
      outerPoints: [-0.1, -0.2, 0.1, -0.2, 0.1, 0.2, -0.1, 0.2],
      transform: transformAt(-5.5, 12.125, 7.75),
      extrusionDir: [1, 0, 0],
      extrusionDepth: 6,
    }),
  ];
}

const SHIFT = { x: 1200, y: 30, z: -800 };

describe('buildProfileEntries (#2183)', () => {
  it('reproduces the deleted main-thread walk exactly', () => {
    const flat = collectFlatProfiles(makeCollection(fixture()));
    // `structuredClone` stands in for the `postMessage` hop.
    const viaWorker = buildProfileEntries(structuredClone(flat), SHIFT, 0);
    const legacy = legacyWalk(makeCollection(fixture()), SHIFT);

    assert.deepStrictEqual(viaWorker, legacy);
    // Guard against a vacuous pass: two empty arrays satisfy deepStrictEqual.
    assert.equal(legacy.length, 3);
    assert.deepStrictEqual(legacy.map((p) => p.expressId), [101, 102, 33_554_433]);
  });

  it('subtracts the render-frame shift from the translation column only', () => {
    const flat = collectFlatProfiles(makeCollection(fixture()));
    const [first] = buildProfileEntries(flat, SHIFT, 0);
    assert.equal(first.transform[12], f32(1200.5) - 1200);
    assert.equal(first.transform[13], f32(30.25) - 30);
    assert.equal(first.transform[14], f32(-800.125) + 800);
    // The rotation/scale block is untouched.
    assert.deepStrictEqual(
      Array.from(first.transform.subarray(0, 12)),
      [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    );
  });

  it('gives each entry its own copies, not views into the shared buffers', () => {
    const flat = collectFlatProfiles(makeCollection(fixture()));
    const profiles = buildProfileEntries(flat, SHIFT, 0);
    for (const p of profiles) {
      // Each view must be checked against ITS OWN source array. Comparing all
      // five against flat.outerPoints made four of the five assertions pass
      // trivially, since a holePoints view could never share that buffer.
      const pairs: [Uint8Array | Uint32Array | Float32Array, Uint8Array | Uint32Array | Float32Array][] = [
        [p.outerPoints, flat.outerPoints],
        [p.holeCounts, flat.holeCounts],
        [p.holePoints, flat.holePoints],
        [p.transform, flat.transform],
        [p.extrusionDir, flat.extrusionDir],
      ];
      for (const [view, origin] of pairs) {
        assert.notEqual(
          view.buffer,
          origin.buffer,
          'a cached entry must not alias the concatenated flatten',
        );
        assert.equal(view.byteOffset, 0);
      }
    }
    // Mutating a rebuilt entry must not reach back into the flatten.
    profiles[0].outerPoints[0] = 999;
    assert.equal(flat.outerPoints[0], 0);
  });

  it('stamps the model index it is given', () => {
    const profiles = buildProfileEntries(
      collectFlatProfiles(makeCollection(fixture())),
      SHIFT,
      3,
    );
    assert.deepStrictEqual(profiles.map((p) => p.modelIndex), [3, 3, 3]);
  });

  // The bug this shape has already produced once (symbolic flatten review): an
  // 8-bit type index wraps past 256 distinct types and hands an entry somebody
  // else's `ifcType`. The profile type table is unbounded — every product with
  // an extruded body contributes — so this is reachable, not theoretical.
  it('keeps ifcType correct past 256 distinct types', () => {
    const entries = Array.from({ length: 300 }, (_, i) =>
      entry({
        expressId: 1000 + i,
        ifcType: `IfcType${i}`,
        outerPoints: [0, 0, 1, 0, 1, 1],
        transform: transformAt(0, 0, 0),
        extrusionDir: [0, 1, 0],
        extrusionDepth: 1,
      }));
    const profiles = buildProfileEntries(
      collectFlatProfiles(makeCollection(entries)),
      { x: 0, y: 0, z: 0 },
      0,
    );
    assert.equal(profiles.length, 300);
    assert.equal(profiles[299].ifcType, 'IfcType299');
    assert.equal(new Set(profiles.map((p) => p.ifcType)).size, 300);
  });

  it('frees every entry handle, including when the flatten throws', () => {
    const freed: number[] = [];
    const track = (e: FakeEntry): FakeEntry => ({
      ...e,
      free() { freed.push(e.expressId); },
    });
    const good = track(entry({
      expressId: 1,
      ifcType: 'IfcSlab',
      outerPoints: [0, 0, 1, 0, 1, 1],
      transform: transformAt(0, 0, 0),
      extrusionDir: [0, 1, 0],
      extrusionDepth: 1,
    }));
    const bad = track(entry({
      expressId: 2,
      ifcType: 'IfcSlab',
      outerPoints: [0, 0, 1, 0, 1, 1],
      transform: transformAt(0, 0, 0),
      extrusionDir: [0, 1, 0],
      extrusionDepth: 1,
    }));
    // A getter that throws mid-entry: the handle must still be released, or it
    // is left to the FinalizationRegistry and freed against a grown heap.
    Object.defineProperty(bad, 'outerPoints', {
      get() { throw new Error('wasm getter blew up'); },
    });

    assert.throws(() => collectFlatProfiles(makeCollection([good, bad])), /wasm getter blew up/);
    assert.deepStrictEqual(freed, [1, 2]);
  });

  it('rebuilds nothing from an empty flatten', () => {
    const flat = collectFlatProfiles(makeCollection([]));
    assert.deepStrictEqual(buildProfileEntries(flat, SHIFT, 0), []);
  });
});
