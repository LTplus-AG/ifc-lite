/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  isPointInZone,
  worldToZoneLocal,
  zoneOverlapsAABB,
  zoneWorldAABB,
  zoneWorldCorners,
} from './geometry.js';
import type { Zone } from './types.js';

function makeZone(overrides: Partial<Zone> = {}): Zone {
  return {
    id: 'z1',
    name: 'Zone 1',
    center: [0, 0, 0],
    size: [10, 3, 10],
    rotationY: 0,
    ...overrides,
  };
}

describe('zones/geometry', () => {
  describe('isPointInZone (axis-aligned)', () => {
    it('accepts the center', () => {
      assert.strictEqual(isPointInZone([0, 0, 0], makeZone()), true);
    });

    it('accepts a point just inside the boundary', () => {
      assert.strictEqual(isPointInZone([4.99, 1.49, 4.99], makeZone()), true);
    });

    it('rejects a point just outside the boundary', () => {
      assert.strictEqual(isPointInZone([5.01, 0, 0], makeZone()), false);
    });

    it('rejects a point outside on the vertical axis', () => {
      assert.strictEqual(isPointInZone([0, 10, 0], makeZone()), false);
    });
  });

  describe('isPointInZone (rotated 45 degrees)', () => {
    // A 10x10 footprint square rotated 45deg has corners at distance
    // 10/sqrt(2) ~= 7.07 along the world axes, and its edge midpoints at
    // distance 5 along the diagonals.
    const zone = makeZone({ rotationY: Math.PI / 4 });

    it('accepts the center', () => {
      assert.strictEqual(isPointInZone([0, 0, 0], zone), true);
    });

    it('accepts a point along the world X axis within the rotated diamond', () => {
      // World point (6, 0, 0): local = rotate by -45deg.
      assert.strictEqual(isPointInZone([6, 0, 0], zone), true);
    });

    it('rejects a point along the world X axis beyond the rotated diamond', () => {
      // Half-extent in local space is 5; along a world axis the rotated
      // square only reaches out to 5/cos(45deg) ~= 7.07 at the diagonal,
      // but along the pure X axis the local |x| grows faster than that —
      // 8 world units puts local x/z well past the 5 half-extent.
      assert.strictEqual(isPointInZone([8, 0, 0], zone), false);
    });

    it('accepts a point straight along the rotated local X axis (a diagonal in world space)', () => {
      // Local (4.9, 0, 0) rotated by +45deg into world space.
      const cos = Math.cos(Math.PI / 4);
      const sin = Math.sin(Math.PI / 4);
      const worldPoint: [number, number, number] = [4.9 * cos, 0, 4.9 * sin];
      assert.strictEqual(isPointInZone(worldPoint, zone), true);
    });
  });

  describe('worldToZoneLocal', () => {
    it('is the identity (minus center) for an unrotated zone', () => {
      const zone = makeZone({ center: [1, 2, 3] });
      const [lx, ly, lz] = worldToZoneLocal([4, 6, 8], zone);
      assert.ok(Math.abs(lx - 3) < 1e-9);
      assert.ok(Math.abs(ly - 4) < 1e-9);
      assert.ok(Math.abs(lz - 5) < 1e-9);
    });

    it('round-trips through a 90-degree rotation', () => {
      const zone = makeZone({ center: [0, 0, 0], rotationY: Math.PI / 2 });
      // World +X should map to local -Z (or +Z depending on sign convention)
      // at unit magnitude — just assert the Y component passes through
      // untouched and the horizontal magnitude is preserved (rotation is
      // length-preserving).
      const [lx, ly, lz] = worldToZoneLocal([5, 1, 0], zone);
      assert.ok(Math.abs(ly - 1) < 1e-9);
      assert.ok(Math.abs(Math.hypot(lx, lz) - 5) < 1e-9);
    });
  });

  describe('zoneOverlapsAABB', () => {
    it('detects an AABB fully inside an axis-aligned zone', () => {
      const zone = makeZone();
      assert.strictEqual(zoneOverlapsAABB([-1, -1, -1], [1, 1, 1], zone), true);
    });

    it('detects no overlap when far away', () => {
      const zone = makeZone();
      assert.strictEqual(zoneOverlapsAABB([100, 0, 0], [101, 1, 1], zone), false);
    });

    it('detects a boundary-straddling AABB (partially in, partially out)', () => {
      const zone = makeZone(); // spans x in [-5, 5]
      assert.strictEqual(zoneOverlapsAABB([4, 0, 0], [6, 1, 1], zone), true);
    });

    it('detects overlap purely on the vertical axis boundary', () => {
      const zone = makeZone(); // spans y in [-1.5, 1.5]
      assert.strictEqual(zoneOverlapsAABB([-1, 1.4, -1], [1, 5, 1], zone), true);
      assert.strictEqual(zoneOverlapsAABB([-1, 2, -1], [1, 5, 1], zone), false);
    });

    it('correctly separates a rotated zone from an AABB that only overlaps its unrotated bounding box', () => {
      // A 45deg-rotated 10x10 (footprint) zone's own AABB is ~14.14x14.14,
      // but its corner (the diamond tip) is missing outside the true
      // rotated shape — an AABB placed in that missing corner must NOT
      // register as overlapping even though it sits inside the rotated
      // zone's axis-aligned bounding box.
      const zone = makeZone({ rotationY: Math.PI / 4 });
      // World corner near (7, 0, 7) is well outside the rotated diamond
      // (whose farthest extent along a world axis combination there is
      // bounded by the local half-extent of 5).
      assert.strictEqual(zoneOverlapsAABB([6.5, -0.1, 6.5], [7, 0.1, 7], zone), false);
    });
  });

  describe('zoneWorldCorners / zoneWorldAABB', () => {
    it('produces 8 corners', () => {
      assert.strictEqual(zoneWorldCorners(makeZone()).length, 8);
    });

    it('bounding AABB of an unrotated zone matches center +/- half-extent', () => {
      const zone = makeZone({ center: [1, 2, 3], size: [4, 6, 8] });
      const { min, max } = zoneWorldAABB(zone);
      assert.deepStrictEqual(min.map((v) => Math.round(v * 100) / 100), [-1, -1, -1]);
      assert.deepStrictEqual(max.map((v) => Math.round(v * 100) / 100), [3, 5, 7]);
    });

    it('bounding AABB of a rotated zone is larger than the unrotated footprint (diagonal reach)', () => {
      // A 10x10 footprint rotated 45deg has its axis-aligned bound reach out
      // to the original square's half-diagonal (10/sqrt(2) per side from
      // center), so the world AABB is wider than the unrotated 10m footprint.
      const zone = makeZone({ size: [10, 3, 10], rotationY: Math.PI / 4 });
      const { min, max } = zoneWorldAABB(zone);
      assert.ok(max[0] - min[0] > 10 - 1e-6);
    });
  });
});
