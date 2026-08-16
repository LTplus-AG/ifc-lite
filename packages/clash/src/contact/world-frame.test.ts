/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * World-frame corpus coverage for the contact pipeline (#2600, fix PR #2661).
 *
 * Before #2661, `scaledPlaneEps` (narrow-phase.ts) sized the coplanarity
 * tolerance from the max |coordinate| over ALL THREE axes of both AABBs,
 * then compared it against a signed distance along ONE plane normal. A model
 * 10 km out in X therefore handed a Z-normal test a ~2.4 mm epsilon derived
 * entirely from the irrelevant X magnitude — and a genuine ~2 mm
 * Z-clearance read as coplanar contact. #2661 replaced that scalar with
 * per-axis f32-ULP noise projected onto each tested plane's own normal. The
 * corpus places the SAME pair at the origin and far out on an ORTHOGONAL
 * axis; a frame-correct tolerance answers identically, and this file exists
 * to keep it that way.
 *
 * Shape conforms to PR #2661's measured reproduction (`clearanceQuadsAt`):
 * horizontal quads with the lower plane at z = 0, offset applied to X only,
 * clearance above any legitimate Z noise yet INSIDE the default broad-phase
 * inflation, so all 2x2 candidate pairs are emitted and the verdict rests on
 * `planeEps` ALONE. One deliberate deviation: the corpus bakes coordinates
 * through f32 (ingestion realism), and f32(0.002) lands a hair ABOVE the
 * default 2 mm inflation — which would silently drop the candidates — so
 * the clearance here is 1.9 mm, robustly inside the inflation and still
 * comfortably swallowed by the pre-#2661 ~2.4 mm far-placement epsilon, so
 * the case remains a genuine discriminator against a regression.
 *
 * The clash contact `Mesh` has NO RTC-origin field (positions are world-
 * frame by contract), so this file carries only the large-world-coordinate
 * axis of the corpus; the per-element `MeshData.origin` axis lives in the
 * viewer compare tests (#2529 path).
 *
 * The far-placement clearance case was authored as `it.fails` against the
 * live defect and was un-wrapped once #2661 landed; it is now an ordinary
 * passing test. The flush counter-cases guard the other direction, so the
 * corpus cannot silently rot either way.
 */

import { describe, expect, it } from 'vitest';
import {
  WORLD_FRAME_OFFSET_M,
  bakedWorldPositions,
  normalProjectedNoiseBound,
  placeWorldFrame,
  quadTriangles,
  type PlacedMesh,
  type WorldFrameCase,
} from '@ifc-lite/world-frame-fixtures';
import { contactClusters, narrowPhase, type Mesh } from './index.js';

/** One f32 ULP up: adjacent-but-not-identical float32 values, the real shape
 * of an intended-flush boundary after independent f32 authoring. */
function nextF32(x: number): number {
  const buf = new Float32Array([x]);
  new Uint32Array(buf.buffer)[0] += 1;
  return buf[0] as number;
}

/** A 1.9 mm clearance: three orders of magnitude above the legitimate
 * Z-noise bound in every corpus case (asserted below, not assumed) and
 * inside the default 2 mm broad-phase inflation, so `planeEps` alone
 * decides. See the module doc for why not the nominal 2.0 mm. */
const CLEARANCE_M = 0.0019;

/** Two horizontal 1 m x 1 m faces (plane normal Z), the lower on z = 0 and
 * the upper `gapM` above it, placed per the corpus case. The far case puts
 * the offset on X — a DIFFERENT axis from the Z normal under test, so a
 * max-over-axes tolerance is caught rather than coincidentally agreeing
 * with the correct projection.
 *
 * `gapM === 0` builds the intended-FLUSH pair instead: both faces at
 * z = 0.5, the upper one f32 ULP off (~6e-8) — adjacent-but-not-identical,
 * the real shape of independently authored flush geometry at building-scale
 * coordinates. */
function horizontalFacePair(
  frameCase: WorldFrameCase,
  gapM: number,
): { a: Mesh; b: Mesh; placed: [PlacedMesh, PlacedMesh] } {
  const lower = quadTriangles('z', gapM === 0 ? 0.5 : 0);
  const upper = quadTriangles('z', gapM === 0 ? nextF32(0.5) : gapM);
  const pa = placeWorldFrame(lower.positions, { frameCase });
  const pb = placeWorldFrame(upper.positions, { frameCase });
  return {
    a: { id: 'A', positions: bakedWorldPositions(pa), indices: lower.indices },
    b: { id: 'B', positions: bakedWorldPositions(pb), indices: upper.indices },
    placed: [pa, pb],
  };
}

describe('contact world-frame corpus (#2600)', () => {
  it('the clearance is provably above the legitimate Z-noise bound in every case', () => {
    for (const frameCase of ['at-origin', 'far-baked'] as const) {
      const { placed } = horizontalFacePair(frameCase, CLEARANCE_M);
      const bound = Math.max(1e-6, normalProjectedNoiseBound([0, 0, 1], placed));
      expect(CLEARANCE_M).toBeGreaterThan(1000 * bound);
    }
  });

  it('counter-case: a genuinely flush pair at the origin is reported as surface contact', () => {
    // Guards the other direction: a "fix" that simply tightens every
    // tolerance re-drops the flush shared face that PR #2600 existed to keep.
    const { a, b } = horizontalFacePair('at-origin', 0);
    const clusters = contactClusters(a, b);
    expect(clusters.some((c) => c.kind === 'surface')).toBe(true);
  });

  it('a genuinely flush pair stays reported 10 km out (offset on X, normal on Z)', () => {
    // The positive case AT the large offset: without it, a naive
    // "just use a smaller epsilon" change looks correct while silently
    // breaking real coplanar detection far from the origin. The flush
    // faces' Z values are identical to the at-origin pair (the offset
    // touches only X), so this must hold before AND after the fix.
    const { a, b } = horizontalFacePair('far-baked', 0);
    const clusters = contactClusters(a, b);
    expect(clusters.some((c) => c.kind === 'surface')).toBe(true);
  });

  it('counter-case: the Z-clearance at the origin produces no pairs and no contact', () => {
    const { a, b } = horizontalFacePair('at-origin', CLEARANCE_M);
    expect(narrowPhase(a, b)).toEqual([]);
    expect(contactClusters(a, b)).toEqual([]);
  });

  // The case the corpus was built for. On the pre-#2661 code this failed:
  // scaledPlaneEps derived ~2.4 mm from the 10 km X magnitude and swallowed
  // the genuine clearance as coplanar contact — measured on that code, 4
  // fabricated coplanar triangle pairs (2 tris x 2 tris) and 1 fabricated
  // surface cluster (area 1 m2, plane normal Z). The projected tolerance
  // takes only the Z-axis noise for a Z normal, so the clearance reads as
  // clear at 10 km exactly as it does at the origin.
  it(`the Z-clearance ${WORLD_FRAME_OFFSET_M / 1000} km out in X produces no pairs and no contact (#2600)`, () => {
    const { a, b } = horizontalFacePair('far-baked', CLEARANCE_M);
    expect(narrowPhase(a, b)).toEqual([]);
    expect(contactClusters(a, b)).toEqual([]);
  });
});
