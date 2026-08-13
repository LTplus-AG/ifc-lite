/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  apportionElementVolume,
  clippedVolumeForZone,
  meshVolume,
  SUM_TOLERANCE_REL,
} from './apportionment.js';
import { compileZone } from './geometry.js';
import { assignElementsToZoneSet } from './assignment.js';
import type { Zone, ZoneSet } from './types.js';

// ============================================================================
// Mesh builders. One extrusion convention, derived once and pinned by the
// analytic volumes in "builders produce the volume they claim" below:
//   `loop` is a simple polygon [[x,z],...] with POSITIVE signed area, swept
//   from y0 to y1. Side quad for edge i is (p0,p3,p2)+(p0,p2,p1), which gives
//   the outward normal (e_z, 0, -e_x); the bottom fan (l0,l_i,l_i+1) at y0
//   gives -Y and the reversed fan at y1 gives +Y.
// Fan-from-l0 is valid for NON-CONVEX loops (the curved wall below is an
// annular sector): overlapping fan triangles carry opposite signs and cancel
// in every integral used here.
// ============================================================================

interface Mesh {
  positions: Float64Array;
  indices: Uint32Array;
}

function meshFromTriangleSoup(coords: number[]): Mesh {
  const indices = new Uint32Array(coords.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions: new Float64Array(coords), indices };
}

function loopSignedArea(loop: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, z0] = loop[i]!;
    const [x1, z1] = loop[(i + 1) % loop.length]!;
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

function extrudeLoop(loop: Array<[number, number]>, y0: number, y1: number): Mesh {
  const l = loopSignedArea(loop) < 0 ? [...loop].reverse() : loop;
  const out: number[] = [];
  const n = l.length;
  for (let i = 0; i < n; i++) {
    const [xa, za] = l[i]!;
    const [xb, zb] = l[(i + 1) % n]!;
    out.push(xa, y0, za, xa, y1, za, xb, y1, zb);
    out.push(xa, y0, za, xb, y1, zb, xb, y0, zb);
  }
  const [x0, z0] = l[0]!;
  for (let i = 1; i + 1 < n; i++) {
    const [xa, za] = l[i]!;
    const [xb, zb] = l[i + 1]!;
    out.push(x0, y0, z0, xa, y0, za, xb, y0, zb);
    out.push(x0, y1, z0, xb, y1, zb, xa, y1, za);
  }
  return meshFromTriangleSoup(out);
}

/** Axis-aligned (or Y-rotated) box, centred at (cx,cy,cz), FULL extents. */
function boxMesh(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, rotY = 0): Mesh {
  const hx = sx / 2;
  const hz = sz / 2;
  const c = Math.cos(rotY);
  const s = Math.sin(rotY);
  const P = (lx: number, lz: number): [number, number] => [cx + lx * c - lz * s, cz + (lx * s + lz * c)];
  return extrudeLoop([P(-hx, -hz), P(hx, -hz), P(hx, hz), P(-hx, hz)], cy - sy / 2, cy + sy / 2);
}

/** Round column: a cylinder along Y. */
function cylinderMesh(cx: number, cy: number, cz: number, r: number, h: number, seg = 64): Mesh {
  const loop: Array<[number, number]> = [];
  for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg;
    loop.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return extrudeLoop(loop, cy - h / 2, cy + h / 2);
}

/** Curved wall: an annular sector (arc a0..a1, radii rIn/rOut) extruded in Y. */
function curvedWallMesh(
  cx: number, cy: number, cz: number,
  rIn: number, rOut: number, a0: number, a1: number, h: number, seg = 96,
): Mesh {
  const loop: Array<[number, number]> = [];
  for (let i = 0; i <= seg; i++) {
    const a = a0 + ((a1 - a0) * i) / seg;
    loop.push([cx + rOut * Math.cos(a), cz + rOut * Math.sin(a)]);
  }
  for (let i = seg; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / seg;
    loop.push([cx + rIn * Math.cos(a), cz + rIn * Math.sin(a)]);
  }
  return extrudeLoop(loop, cy - h / 2, cy + h / 2);
}

/** Reverse every triangle's winding — a mesh wound inward throughout. */
function flipWinding(mesh: Mesh): Mesh {
  const indices = Uint32Array.from(mesh.indices);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const tmp = indices[t + 1]!;
    indices[t + 1] = indices[t + 2]!;
    indices[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices };
}

function zone(overrides: Partial<Zone> & Pick<Zone, 'id'>): Zone {
  return {
    name: overrides.id,
    center: [0, 0, 0],
    size: [10, 10, 10],
    rotationY: 0,
    ...overrides,
  };
}

/** A zone spanning world x in [x0,x1], unbounded (practically) in Y and Z. */
function xSlab(id: string, x0: number, x1: number): Zone {
  return zone({ id, name: id, center: [(x0 + x1) / 2, 0, 0], size: [x1 - x0, 1000, 1000] });
}

function close(actual: number, expected: number, tol: number, what: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected} +/- ${tol}, got ${actual} (delta ${actual - expected})`,
  );
}

function shareOf(result: ReturnType<typeof apportionElementVolume>, zoneId: string): number {
  return result.shares.find((s) => s.zoneId === zoneId)?.volumeM3 ?? 0;
}

/**
 * The REJECTED alternative from #2508's "exact clip vs proportional estimate"
 * question, kept here so the tests below measure the shipped clip against it
 * rather than describing the difference in prose. Splits an element's volume by
 * how much of its AXIS-ALIGNED BOUNDING BOX falls in the zone — nearly free,
 * and blind to the element's actual shape.
 */
function aabbProportionalShare(mesh: Mesh, z: Zone): number {
  const p = mesh.positions;
  let mn = [Infinity, Infinity, Infinity];
  let mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a]!;
      if (v < mn[a]!) mn[a] = v;
      if (v > mx[a]!) mx[a] = v;
    }
  }
  let frac = 1;
  for (let a = 0; a < 3; a++) {
    const ext = mx[a]! - mn[a]!;
    if (!(ext > 0)) return 0;
    const lo = z.center[a]! - z.size[a]! / 2;
    const hi = z.center[a]! + z.size[a]! / 2;
    frac *= Math.max(0, Math.min(mx[a]!, hi) - Math.max(mn[a]!, lo)) / ext;
  }
  return frac * meshVolume([mesh]);
}

describe('zones/apportionment', () => {
  describe('builders produce the volume they claim (pins the winding convention)', () => {
    it('box', () => {
      const m = boxMesh(0.3, 1.5, -0.2, 6, 3, 0.4);
      close(meshVolume([m]), 6 * 3 * 0.4, 1e-12, 'box volume');
    });

    it('cylinder', () => {
      const m = cylinderMesh(0, 1.5, 0, 0.3, 3, 4096);
      close(meshVolume([m]), Math.PI * 0.09 * 3, 1e-4, 'cylinder volume');
    });

    it('curved wall (non-convex loop, fan triangulation cancels)', () => {
      const m = curvedWallMesh(0, 1.5, 0, 4.85, 5.15, 0, Math.PI / 2, 3, 4096);
      const expected = (Math.PI / 4) * (5.15 ** 2 - 4.85 ** 2) * 3;
      close(meshVolume([m]), expected, 1e-3, 'curved wall volume');
    });
  });

  // ==========================================================================
  // Hand-computable cases. Every expected number below is arithmetic a reader
  // can redo on paper, which is the point: these are the numbers people will
  // trust.
  // ==========================================================================
  describe('hand-computable cases', () => {
    // A 6.00 x 3.00 x 0.40 m wall centred on the origin: 7.200 m3 exactly.
    const WALL_VOLUME = 6 * 3 * 0.4;
    const wall = () => boxMesh(0, 1.5, 0, 6, 3, 0.4);

    it('whole wall volume is 7.2 m3', () => {
      close(meshVolume([wall()]), 7.2, 1e-12, 'wall');
    });

    it('crossing ONE boundary at a known fraction (x = -0.6 cuts 2.4 m of 6 m = 40%)', () => {
      // Zone A covers x in [-3, -0.6]: 2.4 m of the wall's 6 m length.
      const a = xSlab('A', -3, -0.6);
      const b = xSlab('B', -0.6, 3);
      const r = apportionElementVolume([wall()], [a, b]);
      close(r.wholeVolumeM3, WALL_VOLUME, 1e-12, 'whole');
      close(shareOf(r, 'A'), 0.4 * WALL_VOLUME, 1e-12, 'A share');   // 2.880 m3
      close(shareOf(r, 'B'), 0.6 * WALL_VOLUME, 1e-12, 'B share');   // 4.320 m3
      close(r.shares.find((s) => s.zoneId === 'A')!.fraction, 0.4, 1e-12, 'A fraction');
      close(r.outsideVolumeM3, 0, 1e-12, 'outside');
      assert.strictEqual(r.overlapping, false);
    });

    it('crossing TWO boundaries (three takt areas, 1 m / 3.5 m / 1.5 m of 6 m)', () => {
      const a = xSlab('A', -3, -2);       // 1.0 m -> 1/6
      const b = xSlab('B', -2, 1.5);      // 3.5 m -> 3.5/6
      const c = xSlab('C', 1.5, 3);       // 1.5 m -> 1.5/6
      const r = apportionElementVolume([wall()], [a, b, c]);
      close(shareOf(r, 'A'), (1 / 6) * WALL_VOLUME, 1e-12, 'A');     // 1.200 m3
      close(shareOf(r, 'B'), (3.5 / 6) * WALL_VOLUME, 1e-12, 'B');   // 4.200 m3
      close(shareOf(r, 'C'), (1.5 / 6) * WALL_VOLUME, 1e-12, 'C');   // 1.800 m3
      close(shareOf(r, 'A') + shareOf(r, 'B') + shareOf(r, 'C'), WALL_VOLUME, 1e-12, 'sum');
      close(r.outsideVolumeM3, 0, 1e-12, 'outside');
    });

    it('wholly inside one zone: that zone gets 100%, nothing outside', () => {
      const r = apportionElementVolume([wall()], [xSlab('A', -50, 50)]);
      close(shareOf(r, 'A'), WALL_VOLUME, 1e-12, 'A');
      close(r.shares[0]!.fraction, 1, 1e-12, 'fraction');
      close(r.outsideVolumeM3, 0, 1e-12, 'outside');
    });

    it('wholly outside every zone: no shares, everything outside', () => {
      const r = apportionElementVolume([wall()], [xSlab('A', 100, 120)]);
      assert.deepStrictEqual(r.shares, []);
      close(r.outsideVolumeM3, WALL_VOLUME, 1e-12, 'outside');
      close(r.outsideFraction, 1, 1e-12, 'outside fraction');
    });

    it('partly outside: the remainder is reported, not silently dropped', () => {
      // Zone covers x in [-3, 0] only -> half the wall is in no zone at all.
      const r = apportionElementVolume([wall()], [xSlab('A', -3, 0)]);
      close(shareOf(r, 'A'), WALL_VOLUME / 2, 1e-12, 'A');
      close(r.outsideVolumeM3, WALL_VOLUME / 2, 1e-12, 'outside');
      close(r.outsideFraction, 0.5, 1e-12, 'outside fraction');
    });

    it('a fraction of a fraction: 25% along x AND the top 1 m of 3 m', () => {
      // x in [-3,-1.5] (25%) and y in [2,3] (the top 1 m of a 0..3 wall).
      const z = zone({ id: 'A', center: [-2.25, 2.5, 0], size: [1.5, 1, 1000] });
      const r = apportionElementVolume([wall()], [z]);
      close(shareOf(r, 'A'), 1.5 * 1 * 0.4, 1e-12, 'A');   // 0.600 m3
      close(r.shares[0]!.fraction, 0.6 / 7.2, 1e-12, 'fraction');
    });
  });

  // ==========================================================================
  // The v1 straddle convention. STRADDLE_PENETRATION_M is a NEGATIVE epsilon:
  // an element ending exactly on a boundary shared by two tiling takt areas
  // does NOT straddle. Apportionment must agree.
  // ==========================================================================
  describe('agreement with v1s negative-epsilon straddle convention', () => {
    it('an element ending EXACTLY on a shared boundary gets no share of the neighbour', () => {
      // Wall spans x in [-3, 0]; zones tile at exactly x = 0.
      const wall = boxMesh(-1.5, 1.5, 0, 3, 3, 0.4);
      const a = xSlab('A', -6, 0);
      const b = xSlab('B', 0, 6);
      const r = apportionElementVolume([wall], [a, b]);
      close(shareOf(r, 'A'), 3 * 3 * 0.4, 1e-12, 'A gets all of it');
      assert.strictEqual(
        r.shares.some((s) => s.zoneId === 'B'), false,
        'the abutting zone must not appear in the breakdown at all',
      );
      close(r.outsideVolumeM3, 0, 1e-12, 'outside');
    });

    it('v1 says "does not straddle" => apportionment yields exactly one share', () => {
      // Same geometry, driven through v1's own classifier so the two agree by
      // construction rather than by a hand-copied threshold.
      const wall = boxMesh(-1.5, 1.5, 0, 3, 3, 0.4);
      const zoneSet: ZoneSet = {
        id: 'zs', name: 'Takt', visible: true, createdAt: 0, updatedAt: 0,
        zones: [xSlab('A', -6, 0), xSlab('B', 0, 6)],
      };
      const v1 = assignElementsToZoneSet(
        [{ globalId: 1, min: [-3, 0, -0.2], max: [0, 3, 0.2] }],
        zoneSet,
      ).get(1)!;
      assert.strictEqual(v1.straddles, false, 'v1 must not flag this as a straddler');

      const r = apportionElementVolume([wall], zoneSet.zones);
      assert.strictEqual(r.shares.length, 1, 'a non-straddler must not get a split apportionment');
      assert.strictEqual(r.shares[0]!.zoneId, 'A');
    });

    it('v1 says "straddles" => apportionment splits, and the split sums to the whole', () => {
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4); // x in [-3, 3]
      const zoneSet: ZoneSet = {
        id: 'zs', name: 'Takt', visible: true, createdAt: 0, updatedAt: 0,
        zones: [xSlab('A', -6, 0), xSlab('B', 0, 6)],
      };
      const v1 = assignElementsToZoneSet(
        [{ globalId: 1, min: [-3, 0, -0.2], max: [3, 3, 0.2] }],
        zoneSet,
      ).get(1)!;
      assert.strictEqual(v1.straddles, true);

      const r = apportionElementVolume([wall], zoneSet.zones);
      assert.strictEqual(r.shares.length, 2);
      close(shareOf(r, 'A'), 3.6, 1e-12, 'A');
      close(shareOf(r, 'B'), 3.6, 1e-12, 'B');
    });
  });

  // ==========================================================================
  // Rotated zones. v1's SAT is exact and tested against a rotated
  // false-positive corner; apportionment has to hold there too.
  // ==========================================================================
  describe('rotated zones', () => {
    it('a 45-degree zone cutting a cube on its diagonal takes exactly half', () => {
      const cube = boxMesh(0, 0, 0, 2, 2, 2); // 8 m3
      const a = Math.PI / 4;
      // A zone whose local +z face passes through the origin along the 45deg
      // diagonal: centre offset by half its local-z depth along the local -z
      // axis, which in world is (sin a, 0, -cos a) * 25.
      const half = zone({
        id: 'A', center: [25 * Math.sin(a), 0, -25 * Math.cos(a)], size: [100, 100, 50], rotationY: a,
      });
      const other = zone({
        id: 'B', center: [-25 * Math.sin(a), 0, 25 * Math.cos(a)], size: [100, 100, 50], rotationY: a,
      });
      const r = apportionElementVolume([cube], [half, other]);
      close(r.wholeVolumeM3, 8, 1e-12, 'whole');
      close(shareOf(r, 'A'), 4, 1e-9, 'A half');
      close(shareOf(r, 'B'), 4, 1e-9, 'B half');
      close(r.outsideVolumeM3, 0, 1e-9, 'outside');
    });

    it('a rotated zone that only LOOKS overlapping by AABB gets zero volume', () => {
      // The rotated-false-positive geometry from v1's SAT tests: a small box
      // near the world-axis corner of a 45deg-rotated zone's AABB, outside the
      // rotated footprint itself.
      const small = boxMesh(6.6, 0, 6.6, 0.4, 0.4, 0.4);
      const rotated = zone({ id: 'A', center: [0, 0, 0], size: [10, 10, 10], rotationY: Math.PI / 4 });
      const r = apportionElementVolume([small], [rotated]);
      assert.deepStrictEqual(r.shares, [], 'no share for a zone the element does not actually enter');
      close(r.outsideFraction, 1, 1e-12, 'entirely outside');
    });

    it('a rotated zone apportions a rotated wall at a hand-computable fraction', () => {
      // Wall and zone share the same 30deg rotation, so the split is purely
      // 1-D along their common local x: zone covers local x in [-2, 0.5] of a
      // wall spanning [-3, 3] -> 2.5/6.
      const rot = Math.PI / 6;
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4, rot);
      const c = Math.cos(rot);
      const s = Math.sin(rot);
      const localCx = -0.75; // centre of [-2, 0.5]
      const z = zone({
        id: 'A', center: [localCx * c, 1.5, localCx * s], size: [2.5, 100, 100], rotationY: rot,
      });
      const r = apportionElementVolume([wall], [z]);
      close(shareOf(r, 'A'), (2.5 / 6) * 7.2, 1e-9, 'A');
    });
  });

  // ==========================================================================
  // Shapes an AABB-ratio estimate gets badly wrong. These pin that the clip is
  // shape-aware, not a bounding-box proportion.
  // ==========================================================================
  describe('non-box shapes', () => {
    it('a curved wall gets ZERO volume in a zone sitting in its inner corner', () => {
      // Quarter annulus of radius ~5 m centred on the origin. A 3 m box near
      // the origin sits in the arc's hollow: it contains none of the wall,
      // while the wall's AABB covers it completely.
      const wallMesh = curvedWallMesh(0, 1.5, 0, 4.85, 5.15, 0, Math.PI / 2, 3);
      const z = zone({ id: 'A', center: [1.5, 1.5, 1.5], size: [3, 4, 3] });
      const r = apportionElementVolume([wallMesh], [z]);
      close(shareOf(r, 'A'), 0, 1e-9, 'inner corner holds none of the wall');
      close(r.outsideFraction, 1, 1e-9, 'all of it is elsewhere');
    });

    it('a round column split by a plane through its axis gives exactly half', () => {
      const col = cylinderMesh(0, 1.5, 0, 0.3, 3, 2048);
      const whole = meshVolume([col]);
      const r = apportionElementVolume([col], [xSlab('A', -10, 0), xSlab('B', 0, 10)]);
      close(shareOf(r, 'A'), whole / 2, 1e-9, 'A');
      close(shareOf(r, 'B'), whole / 2, 1e-9, 'B');
    });
  });

  // ==========================================================================
  // The invariant that decides whether this ships, asserted as a PROPERTY over
  // many elements rather than on hand-picked cases.
  // ==========================================================================
  describe('INVARIANT: shares + outside == whole, for every element', () => {
    // A tiny deterministic PRNG so a failure is reproducible from the seed
    // alone (Math.random would make a red run unreplayable).
    function mulberry32(seed: number): () => number {
      let a = seed >>> 0;
      return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    it('holds over 400 random elements x random rotated tilings', () => {
      const rnd = mulberry32(0x2508);
      let checked = 0;
      let worst = 0;
      let worstWhat = '';

      for (let trial = 0; trial < 400; trial++) {
        // A random element: box, rotated box, column or curved wall, placed
        // anywhere in a 40 m cube (including far from the origin, where the
        // divergence sum is most fragile).
        const px = (rnd() - 0.5) * 40;
        const py = (rnd() - 0.5) * 20;
        const pz = (rnd() - 0.5) * 40;
        const kind = trial % 4;
        let mesh: Mesh;
        if (kind === 0) {
          mesh = boxMesh(px, py, pz, 0.3 + rnd() * 8, 0.3 + rnd() * 5, 0.3 + rnd() * 8);
        } else if (kind === 1) {
          mesh = boxMesh(px, py, pz, 0.3 + rnd() * 8, 0.3 + rnd() * 5, 0.2 + rnd() * 2, rnd() * Math.PI);
        } else if (kind === 2) {
          mesh = cylinderMesh(px, py, pz, 0.1 + rnd() * 1.5, 0.5 + rnd() * 5, 24);
        } else {
          const rIn = 2 + rnd() * 4;
          mesh = curvedWallMesh(px, py, pz, rIn, rIn + 0.2 + rnd(), rnd() * 2, 2 + rnd() * 2, 0.5 + rnd() * 4, 32);
        }
        const whole = Math.abs(meshVolume([mesh]));
        if (!(whole > 1e-9)) continue;

        // A random tiling: parallel slabs at a random rotation, covering a
        // random span so some trials leave part of the element outside.
        const rot = rnd() * Math.PI * 2;
        const width = 1 + rnd() * 12;
        const c = Math.cos(rot);
        const s = Math.sin(rot);
        // The tiling must COVER the element, or the invariant below is not the
        // one being claimed: `outsideVolumeM3` is DEFINED as `whole - assigned`,
        // so "shares + outside == whole" holds by arithmetic and can never
        // fail. Asserting sum(shares) == whole with outside pinned at zero is
        // the falsifiable form -- and it needs full coverage to be true.
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
          const t = mesh.positions[i]! * c + mesh.positions[i + 2]! * s;
          if (t < lo) lo = t;
          if (t > hi) hi = t;
        }
        const first = lo - width;
        const count = Math.ceil((hi - lo + 2 * width) / width);
        const zones: Zone[] = [];
        for (let k = 0; k < count; k++) {
          const cLocal = first + width * k + width / 2;
          zones.push(zone({
            id: `z${k}`, name: `z${k}`,
            center: [cLocal * c, 0, cLocal * s],
            size: [width, 400, 400],
            rotationY: rot,
          }));
        }

        const r = apportionElementVolume([mesh], zones);
        const summed = r.shares.reduce((acc, sh) => acc + sh.volumeM3, 0);
        const rel = Math.abs(summed - r.wholeVolumeM3) / r.wholeVolumeM3;
        if (rel > worst) {
          worst = rel;
          worstWhat = `trial ${trial} kind ${kind} whole=${r.wholeVolumeM3} summed=${summed}`;
        }
        assert.ok(
          rel <= SUM_TOLERANCE_REL,
          `sum-to-whole violated on trial ${trial} (kind ${kind}): whole=${r.wholeVolumeM3}, ` +
            `sum(shares)=${summed}, rel=${rel}`,
        );
        assert.ok(
          r.outsideVolumeM3 <= r.wholeVolumeM3 * SUM_TOLERANCE_REL,
          `a covering tiling must leave nothing outside (trial ${trial}): ${r.outsideVolumeM3}`,
        );
        assert.ok(r.shares.length >= 1, `a covered element must land in at least one zone (trial ${trial})`);
        assert.strictEqual(r.unreliable, false, `a closed mesh must not read unreliable (trial ${trial})`);
        assert.strictEqual(r.overlapping, false, `disjoint tiling must not report overlap (trial ${trial})`);
        // Every share must be a real, non-negative, in-range fraction.
        for (const sh of r.shares) {
          assert.ok(sh.volumeM3 > 0, `share must be positive (trial ${trial}, ${sh.zoneId})`);
          assert.ok(
            sh.fraction > 0 && sh.fraction <= 1 + SUM_TOLERANCE_REL,
            `fraction out of range (trial ${trial}, ${sh.zoneId}): ${sh.fraction}`,
          );
        }
        checked++;
      }

      assert.ok(checked >= 380, `expected ~400 usable trials, ran ${checked}`);
      assert.ok(worst <= SUM_TOLERANCE_REL, `worst relative error ${worst} (${worstWhat})`);
    });

    it('a tiling that only PARTLY covers the element reports the remainder', () => {
      // The complement of the property above: when the zones do not cover the
      // element, `outsideVolumeM3` must be the real remainder, not zero. Half a
      // 7.2 m3 wall is covered, so 3.6 m3 has to show up as outside.
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const r = apportionElementVolume([wall], [xSlab('A', -3, -1.5), xSlab('B', -1.5, 0)]);
      close(r.shares.reduce((a, sh) => a + sh.volumeM3, 0), 3.6, 1e-12, 'sum of shares');
      close(r.outsideVolumeM3, 3.6, 1e-12, 'the uncovered half is reported');
      close(r.outsideFraction, 0.5, 1e-12, 'outside fraction');
    });

    it('holds when the element is wound INWARD throughout', () => {
      const inward = flipWinding(boxMesh(1, 1.5, 2, 6, 3, 0.4));
      const r = apportionElementVolume([inward], [xSlab('A', -50, 1), xSlab('B', 1, 50)]);
      close(r.wholeVolumeM3, 7.2, 1e-12, 'whole is positive despite inward winding');
      close(shareOf(r, 'A'), 3.6, 1e-12, 'A');
      close(shareOf(r, 'B'), 3.6, 1e-12, 'B');
    });
  });

  // ==========================================================================
  // Overlap is possible (v1 does not forbid it) and must be reported, not
  // silently turned into a breakdown that does not add up.
  // ==========================================================================
  describe('overlapping zones', () => {
    it('flags overlap instead of pretending the shares add up', () => {
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const r = apportionElementVolume([wall], [xSlab('A', -50, 50), xSlab('B', -50, 50)]);
      assert.strictEqual(r.overlapping, true);
      close(shareOf(r, 'A'), 7.2, 1e-12, 'A is individually correct');
      close(shareOf(r, 'B'), 7.2, 1e-12, 'B is individually correct');
      close(r.outsideVolumeM3, 0, 1e-12, 'outside is clamped at zero, never negative');
    });
  });

  // ==========================================================================
  // Degenerate input must not crash and must not invent volume.
  // ==========================================================================
  describe('degenerate input', () => {
    it('a zero-size zone yields zero, not NaN', () => {
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const r = apportionElementVolume([wall], [zone({ id: 'A', size: [0, 0, 0] })]);
      assert.deepStrictEqual(r.shares, []);
      assert.ok(Number.isFinite(r.outsideVolumeM3));
      close(r.outsideVolumeM3, 7.2, 1e-12, 'all of it is outside a zero-size zone');
    });

    it('a zero-THICKNESS element yields zero volume everywhere, not NaN', () => {
      // A flat quad has no volume at all; it must not produce a share.
      const flat = meshFromTriangleSoup([
        0, 0, 0, 1, 0, 0, 1, 0, 1,
        0, 0, 0, 1, 0, 1, 0, 0, 1,
      ]);
      const r = apportionElementVolume([flat], [xSlab('A', -5, 5)]);
      close(r.wholeVolumeM3, 0, 1e-12, 'whole');
      assert.deepStrictEqual(r.shares, []);
      assert.strictEqual(r.outsideFraction, 0);
      assert.strictEqual(r.overlapping, false);
    });

    it('an element whose AABB fully CONTAINS the zone gets the zone-sized share', () => {
      const big = boxMesh(0, 0, 0, 20, 20, 20);
      const small = zone({ id: 'A', center: [1, 2, 3], size: [2, 3, 4] });
      const r = apportionElementVolume([big], [small]);
      close(shareOf(r, 'A'), 2 * 3 * 4, 1e-12, 'the whole zone is full of element');
      close(r.outsideVolumeM3, 8000 - 24, 1e-9, 'the rest is outside');
    });

    it('an empty mesh yields zeros', () => {
      const r = apportionElementVolume([{ positions: new Float64Array(0), indices: new Uint32Array(0) }], [xSlab('A', -5, 5)]);
      assert.strictEqual(r.wholeVolumeM3, 0);
      assert.deepStrictEqual(r.shares, []);
      assert.strictEqual(r.outsideVolumeM3, 0);
    });

    it('no zones yields the whole element as outside', () => {
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const r = apportionElementVolume([wall], []);
      close(r.outsideVolumeM3, 7.2, 1e-12, 'outside');
      close(r.outsideFraction, 1, 1e-12, 'outside fraction');
    });

    it('an element wound INCONSISTENTLY is flagged unreliable, not silently clamped', () => {
      // Two bodies in one element, one wound outward and one inward: the
      // surface is not consistently orientable, so no global sign rescues it.
      // The whole reads 64 - 8 = 56 m3 and the zone holding only the inward
      // body clips to -8 m3. `apportionElementVolume` must SAY so rather than
      // clamp that away and hand back a tidy breakdown.
      const outward = boxMesh(-5, 0, 0, 4, 4, 4);       // +64 m3
      const inward = flipWinding(boxMesh(5, 0, 0, 2, 2, 2)); // -8 m3
      const r = apportionElementVolume([outward, inward], [xSlab('A', -50, 0), xSlab('B', 0, 50)]);
      close(r.wholeVolumeM3, 56, 1e-9, 'whole');
      assert.strictEqual(r.unreliable, true, 'a negative share must be reported, not hidden');
      assert.ok(!r.shares.some((sh) => sh.zoneId === 'B'), 'and the negative share is not published as a share');
    });

    it('non-finite vertices are skipped, not propagated as NaN', () => {
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const poisoned = Float64Array.from(wall.positions);
      poisoned[0] = Number.NaN;
      const v = clippedVolumeForZone([{ positions: poisoned, indices: wall.indices }], compileZone(xSlab('A', -50, 50)));
      assert.ok(Number.isFinite(v), `expected a finite volume, got ${v}`);
    });
  });

  // ==========================================================================
  // Renderer meshes are not the tidy f64 solids above: `MeshData.positions` is
  // a Float32Array split into one PIECE per material slice, each carrying its
  // own `origin` (the per-element local frame of #1114). Both have to work, and
  // the f32 one is what sets the shipped tolerance.
  // ==========================================================================
  describe('renderer mesh shape (pieces, origin, f32)', () => {
    /** Split a soup mesh into `n` pieces and rebase each on its own origin, the
     *  way `Scene.getMeshDataPieces` hands geometry back. */
    function toPieces(mesh: Mesh, n: number, origins: Array<[number, number, number]>) {
      const triCount = mesh.indices.length / 3;
      const per = Math.ceil(triCount / n);
      const out = [];
      for (let k = 0; k < n; k++) {
        const from = k * per * 3;
        const to = Math.min(mesh.indices.length, (k + 1) * per * 3);
        if (from >= to) continue;
        const o = origins[k % origins.length]!;
        const positions = new Float64Array((to - from) * 3);
        const indices = new Uint32Array(to - from);
        for (let i = 0; i < to - from; i++) {
          const v = mesh.indices[from + i]! * 3;
          positions[i * 3] = mesh.positions[v]! - o[0];
          positions[i * 3 + 1] = mesh.positions[v + 1]! - o[1];
          positions[i * 3 + 2] = mesh.positions[v + 2]! - o[2];
          indices[i] = i;
        }
        out.push({ positions, indices, origin: o });
      }
      return out;
    }

    it('a multi-piece element with per-piece origins apportions as one solid', () => {
      const wall = boxMesh(120, 1.5, -80, 6, 3, 0.4); // far from the world origin
      const pieces = toPieces(wall, 3, [[120, 0, -80], [119, 2, -81], [0, 0, 0]]);
      assert.ok(pieces.length > 1, 'the fixture must actually be split');
      const r = apportionElementVolume(pieces, [xSlab('A', 100, 119.4), xSlab('B', 119.4, 140)]);
      close(r.wholeVolumeM3, 7.2, 1e-9, 'whole survives the local-frame split');
      close(shareOf(r, 'A'), 0.4 * 7.2, 1e-9, 'A');   // wall spans x 117..123; x = 119.4 cuts 2.4 m of 6 m
      close(shareOf(r, 'B'), 0.6 * 7.2, 1e-9, 'B');
      close(r.outsideVolumeM3, 0, 1e-9, 'outside');
    });

    it('an origin that is NOT folded in would move the element out of the zone', () => {
      // Control for the test above: the same pieces read WITHOUT their origin
      // sit at the world origin, nowhere near the zones, and apportion to
      // nothing. So the assertions above cannot pass by ignoring `origin`.
      const wall = boxMesh(120, 1.5, -80, 6, 3, 0.4);
      const pieces = toPieces(wall, 3, [[120, 0, -80], [119, 2, -81], [0, 0, 0]]);
      const stripped = pieces.map((p) => ({ positions: p.positions, indices: p.indices }));
      const r = apportionElementVolume(stripped, [xSlab('A', 100, 119.4), xSlab('B', 119.4, 140)]);
      assert.deepStrictEqual(r.shares, [], 'sanity: origin is load-bearing');
    });

    it('f32 QUANTISATION alone does not leak: the vertices still coincide', () => {
      // Rounding a mesh whose shared corners hold the same f64 value lands them
      // on the same f32 value too, so the shell stays closed and the sum stays
      // exact. This is why most real elements measure at f64 noise.
      const wall = boxMesh(300, 1.5, 240, 6, 3, 0.4);
      const positions = Float32Array.from(wall.positions);
      const r = apportionElementVolume(
        [{ positions, indices: wall.indices }],
        [xSlab('A', 200, 299), xSlab('B', 299, 400)],
      );
      const rel = Math.abs(r.shares.reduce((a, sh) => a + sh.volumeM3, 0) - r.wholeVolumeM3) / r.wholeVolumeM3;
      assert.ok(rel < 1e-12, `f32 quantisation alone should not crack the shell, leaked ${rel}`);
    });

    it('a CRACKED shell leaks in proportion to the crack, which is why the tolerance is empirical', () => {
      // Where two shared corners did NOT hold the same f64 value they round to
      // f32 coordinates an ULP apart, and the shell opens by that much. The
      // divergence sum then leaks: it is exact only for a closed surface.
      // Measured on 241 real straddlers of a structural model the worst leak is
      // 3.4e-6 relative, because only a few vertices actually split -- but the
      // mechanism scales with the gap, and that is what SUM_TOLERANCE_REL is
      // empirical about. Pin the scaling so a future change cannot quietly make
      // the sum depend on it more strongly.
      const wall = boxMesh(300, 1.5, 240, 6, 3, 0.4);
      const leakAt = (gap: number): number => {
        const positions = new Float32Array(wall.positions.length);
        for (let i = 0; i < positions.length; i++) {
          positions[i] = Math.fround(wall.positions[i]! + ((i % 2) * 2 - 1) * gap);
        }
        const r = apportionElementVolume(
          [{ positions, indices: wall.indices }],
          [xSlab('A', 200, 299), xSlab('B', 299, 400)],
        );
        assert.strictEqual(r.shares.length, 2, 'still splits');
        return Math.abs(r.shares.reduce((a, sh) => a + sh.volumeM3, 0) - r.wholeVolumeM3) / r.wholeVolumeM3;
      };
      const ULP_AT_300M = 3.6e-5;   // one f32 ULP at 300 m from the origin
      const one = leakAt(ULP_AT_300M);
      const ten = leakAt(10 * ULP_AT_300M);
      assert.ok(one > 0, 'a cracked shell must leak, or the fixture stopped cracking');
      close(ten / one, 10, 1.5, 'the leak is LINEAR in the crack width');
    });
  });

  // ==========================================================================
  // #2508 asks the exact-clip-vs-estimate question directly. These are the
  // two shapes it names, built so the right answer is arithmetic on paper.
  // ==========================================================================
  describe('vs the AABB-proportional estimate (#2508 design question 1)', () => {
    it('a DIAGONAL BRACE: the estimate credits 20% of it to a zone holding none', () => {
      // A 0.4 x 0.4 m square member, 8 m long, running along the X/Z diagonal
      // (a 45-degree Y rotation of a box whose local x is its length).
      // Parametrise a point as u along the length, v across the width:
      //   x = (u - v)/sqrt(2),  z = (u + v)/sqrt(2),  |v| <= 0.2
      // so z - x = sqrt(2) * v is bounded by 0.283 m. A zone confined to
      // x <= -0.3 and z >= +0.3 needs z - x >= 0.6 and therefore contains NO
      // part of the brace: the exact share is zero.
      const brace = boxMesh(0, 0, 0, 8, 0.4, 0.4, Math.PI / 4);
      const half = (8 + 0.4) / 2 * Math.SQRT1_2;   // 2.9698 m: the AABB half-extent in x and z
      const lo = 0.3;
      const z = zone({
        id: 'A',
        center: [-(half + lo) / 2, 0, (half + lo) / 2],
        size: [half - lo, 10, half - lo],
      });
      const r = apportionElementVolume([brace], [z]);
      assert.deepStrictEqual(r.shares, [], 'the exact clip finds nothing in that quadrant');

      // The estimate does not: the brace's AABB fills the quadrant.
      const whole = meshVolume([brace]);
      const est = aabbProportionalShare(brace, z);
      // (2.6698 / 5.9397)^2 = 0.202 of the element, from the AABB alone.
      close(est / whole, ((half - lo) / (2 * half)) ** 2, 1e-9, 'estimate fraction');
      assert.ok(est / whole > 0.2, `estimate should be ~20% of the brace, got ${(100 * est / whole).toFixed(1)}%`);
    });

    it('a CURVED WALL: the estimate puts 24% of it inside its own hollow', () => {
      // A quarter-annulus wall of mean radius 5 m. Its AABB is the full
      // 5.15 x 5.15 m quadrant, most of which is the empty inside of the arc.
      // A 2.5 m zone tucked against the centre holds none of the wall.
      const wall = curvedWallMesh(0, 1.5, 0, 4.85, 5.15, 0, Math.PI / 2, 3, 256);
      const z = zone({ id: 'A', center: [1.25, 1.5, 1.25], size: [2.5, 4, 2.5] });
      const r = apportionElementVolume([wall], [z]);
      close(shareOf(r, 'A'), 0, 1e-9, 'the hollow holds none of the wall');
      close(r.outsideFraction, 1, 1e-9, 'all of it is elsewhere');

      const whole = meshVolume([wall]);
      const est = aabbProportionalShare(wall, z);
      assert.ok(est / whole > 0.2, `estimate should be ~24% of the wall, got ${(100 * est / whole).toFixed(1)}%`);
    });

    it('the estimate is not always wrong — it is wrong UNPREDICTABLY', () => {
      // A plain axis-aligned box cut by an axis-aligned slab: the estimate is
      // exactly right. That is why the estimate is tempting, and why "it was
      // fine on my test wall" is not evidence.
      const wall = boxMesh(0, 1.5, 0, 6, 3, 0.4);
      const z = xSlab('A', -3, -0.6);
      close(aabbProportionalShare(wall, z), 0.4 * 7.2, 1e-9, 'estimate on a box');
      close(shareOf(apportionElementVolume([wall], [z]), 'A'), 0.4 * 7.2, 1e-12, 'clip on a box');
    });
  });
});
