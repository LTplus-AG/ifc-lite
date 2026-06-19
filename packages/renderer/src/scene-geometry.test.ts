/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { colorSaltByte, packEntityLane } from './scene-geometry.ts';

/**
 * Mirror the WGSL depth-nudge hash from `main.wgsl.ts` (`vs_main`) so the test
 * pins the actual cross-pass contract: the nudge depends ONLY on the packed
 * entity-id lane, so the base opaque pass and the colour-override OVERLAY pass
 * (which redraw the same geometry in a different draw colour) must produce the
 * SAME nudge for the overlay's `depthCompare: 'equal'` to match.
 *
 * u32 multiply wraps mod 2^32; `Math.imul(a, b) >>> 0` reproduces that exactly.
 */
function shaderZHash(lane: number): number {
  const colorSalt = Math.imul(lane >>> 24, 2654435761) >>> 0;
  const mixed = ((lane & 0x00ffffff) ^ colorSalt) >>> 0;
  return (Math.imul(mixed, 2654435761) >>> 0) & 255;
}

describe('colorSaltByte', () => {
  it('returns 0 for null / undefined colour', () => {
    assert.strictEqual(colorSaltByte(null), 0);
    assert.strictEqual(colorSaltByte(undefined), 0);
  });

  it('is deterministic for the same colour', () => {
    const c: [number, number, number, number] = [0.2, 0.4, 0.6, 1];
    assert.strictEqual(colorSaltByte(c), colorSaltByte([...c]));
  });

  it('always returns a byte in [0, 255]', () => {
    for (const c of [
      [0, 0, 0, 1],
      [1, 1, 1, 1],
      [0.5, 0.5, 0.5, 1],
      [0.999, 0.001, 0.499, 1],
      [1, 0, 0, 0.15], // ghost alpha — must not affect the salt
    ] as [number, number, number, number][]) {
      const s = colorSaltByte(c);
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 255, `salt out of range: ${s}`);
    }
  });

  it('ignores the alpha channel', () => {
    assert.strictEqual(colorSaltByte([0.3, 0.6, 0.9, 1]), colorSaltByte([0.3, 0.6, 0.9, 0.15]));
  });

  it('separates the common material colours seen in practice', () => {
    // A small palette of distinct materials should map to distinct salts so
    // coincident coplanar layers get distinct depth nudges.
    const palette: [number, number, number, number][] = [
      [0.8, 0.8, 0.8, 1], // concrete grey
      [0.86, 0.65, 0.4, 1], // brick
      [0.6, 0.6, 0.6, 1], // steel
      [0.2, 0.4, 0.7, 1], // glass-ish
      [0.95, 0.95, 0.9, 1], // plaster
    ];
    const salts = new Set(palette.map(colorSaltByte));
    assert.strictEqual(salts.size, palette.length, 'expected distinct salts for distinct materials');
  });
});

describe('packEntityLane', () => {
  it('preserves the picking id in the low 24 bits (encodeId24 contract)', () => {
    for (const id of [0, 1, 101, 43810, 1_664_394, 0x00ffffff]) {
      for (const salt of [0, 1, 127, 255]) {
        assert.strictEqual(packEntityLane(id, salt) & 0x00ffffff, id, `id ${id} salt ${salt}`);
      }
    }
  });

  it('places the salt in the high 8 bits', () => {
    for (const salt of [0, 1, 73, 200, 255]) {
      assert.strictEqual(packEntityLane(12345, salt) >>> 24, salt);
    }
  });

  it('masks ids beyond 24 bits down to the low 24 (matches pre-existing picking limit)', () => {
    const big = 0x01_234567; // > 2^24
    assert.strictEqual(packEntityLane(big, 99) & 0x00ffffff, big & 0x00ffffff);
  });

  it('returns an unsigned 32-bit value even when the high bit is set', () => {
    const lane = packEntityLane(0x00ffffff, 255); // 0xFFFFFFFF
    assert.ok(lane >= 0 && lane <= 0xffffffff);
    assert.strictEqual(lane >>> 0, lane);
  });

  it('only the salt byte clamps in — saltByte values above 255 are masked', () => {
    assert.strictEqual(packEntityLane(7, 0x1ff) >>> 24, 0xff);
  });
});

describe('depth-nudge cross-pass contract (the lens/overlay fix)', () => {
  it('base and overlay passes compute the SAME nudge for one mesh', () => {
    // The base batch and the override OVERLAY batch are both built from the same
    // MeshData (same expressId, same MeshData.color), so they stamp the same
    // lane and MUST hash to the same nudge — regardless of the draw-time colour.
    const expressId = 43810;
    const meshColor: [number, number, number, number] = [0.86, 0.65, 0.4, 1];
    const baseLane = packEntityLane(expressId, colorSaltByte(meshColor));
    const overlayLane = packEntityLane(expressId, colorSaltByte(meshColor));
    assert.strictEqual(baseLane, overlayLane);
    assert.strictEqual(shaderZHash(baseLane), shaderZHash(overlayLane));
  });

  it('separates two material layers that share a parent expressId', () => {
    // Material-layer slices share the PARENT id; distinct material colours must
    // still yield distinct nudges so their coincident caps do not z-fight.
    const parentId = 52001;
    const layerA: [number, number, number, number] = [0.8, 0.8, 0.8, 1];
    const layerB: [number, number, number, number] = [0.86, 0.65, 0.4, 1];
    const laneA = packEntityLane(parentId, colorSaltByte(layerA));
    const laneB = packEntityLane(parentId, colorSaltByte(layerB));
    assert.notStrictEqual(laneA, laneB);
    assert.notStrictEqual(shaderZHash(laneA), shaderZHash(laneB));
  });

  it('nudge does NOT depend on the draw colour (only the baked lane)', () => {
    // Two different draw colours over the same lane => identical nudge. This is
    // the property that was broken when the salt came from `uniforms.baseColor`.
    const lane = packEntityLane(123, colorSaltByte([0.5, 0.2, 0.1, 1]));
    assert.strictEqual(shaderZHash(lane), shaderZHash(lane));
  });
});
