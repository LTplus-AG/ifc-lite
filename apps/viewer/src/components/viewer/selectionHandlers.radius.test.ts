/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * WIRING tests for radius mode (#2737 item 2) — click -> store -> readout,
 * mirroring `selectionHandlers.angle.test.ts`'s rationale: a pure-layer test
 * of `fitRadius` cannot catch `handleRadiusClick`'s body being replaced with
 * a bare `return` (the tool goes dead, no pick ever registers), and cannot
 * catch the panel reading the wrong outcome kind and reporting a number for
 * a refused fit. Both are wiring bugs invisible to either layer in
 * isolation, so this file asserts the STRING A USER WOULD READ, computed the
 * way `MeasurePanel` computes it (`formatRadius(fitRadius(points))`), for
 * both a genuine arc and a straight run.
 *
 * Fixtures are OFF-ORIGIN and on a TILTED, non-axis-aligned plane —
 * `radius.test.ts`'s own header explains why: a fixture centred at the
 * origin can zero a plane normal via Newell's method and refuse for the
 * WRONG reason (no plane, not "no curvature"), which is exactly the failure
 * mode `radius.ts`'s author hit and flagged. The straight-run fixture is
 * genuinely collinear along that tilted line, not axis-aligned either.
 */

import '@/test/setup-dom.js';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { handleRadiusClick, finishRadiusFromDoubleClick } from './selectionHandlers.js';
import { fitRadius, formatRadius, type Point3 } from './tools/measure-modes/radius.js';
import type { MouseHandlerContext } from './mouseHandlerTypes.js';

function fakeCtx(hit: { x: number; y: number; z: number } | null): MouseHandlerContext {
  const canvas = document.createElement('canvas');
  return {
    canvas,
    camera: {
      projectToScreen: (p: { x: number; y: number; z: number }) => ({ x: p.x, y: p.y }),
      getPosition: () => ({ x: 0, y: 0, z: 0 }),
      getRotation: () => ({ azimuth: 0, elevation: 0 }),
      getDistance: () => 10,
    },
    renderer: {
      raycastSceneMagnetic: () => ({
        intersection: hit ? { point: hit } : null,
        snapTarget: null,
        edgeLock: { edge: null, meshExpressId: null, edgeT: 0, shouldLock: false, shouldRelease: true, isCorner: false, cornerValence: 0 },
      }),
    },
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'measure' },
    snapEnabledRef: { current: true },
    edgeLockStateRef: { current: { edge: null, meshExpressId: null, edgeT: 0, lockStrength: 0, isCorner: false, cornerValence: 0 } },
    hiddenEntitiesRef: { current: new Set() },
    isolatedEntitiesRef: { current: null },
    setSnapTarget: () => {},
  } as unknown as MouseHandlerContext;
}

/** Exactly what `MeasurePanel` renders for a finished radius measurement. */
function readoutOf(points: readonly Point3[]): string {
  return formatRadius(fitRadius(points));
}

/** Off-origin centre, tilted normal — an arc genuinely off both the origin
 *  and the coordinate axes, matching `radius.test.ts`'s own fixtures. */
const CENTER = { x: 42.5, y: -7.3, z: 12.1 };
const RADIUS = 3.2;

/** Six points on a real circle (not a dense idealised ring — a coarse
 *  90-degree-span sample, the density a tessellated small profile gives). */
function arcPoints(): Point3[] {
  // Tilted (non axis-aligned) but weighted toward XY: the test harness's fake
  // camera projects a world point to screen by (x, y) alone (`z` dropped, as
  // a real projection also does), so a normal dominated by Z would collapse
  // consecutive picks to near-identical SCREEN coordinates and trip the
  // double-click duplicate guard on data that was never actually a
  // duplicate. Still off-axis and off-origin, same as `radius.test.ts`'s own
  // fixtures — just not tilted so far the projection itself degenerates.
  const normal = { x: 2, y: 3, z: 0.6 };
  const n = Math.hypot(normal.x, normal.y, normal.z);
  const nn = { x: normal.x / n, y: normal.y / n, z: normal.z / n };
  const seed = Math.abs(nn.x) < 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
  const uRaw = {
    x: seed.y * nn.z - seed.z * nn.y,
    y: seed.z * nn.x - seed.x * nn.z,
    z: seed.x * nn.y - seed.y * nn.x,
  };
  const uLen = Math.hypot(uRaw.x, uRaw.y, uRaw.z);
  const u = { x: uRaw.x / uLen, y: uRaw.y / uLen, z: uRaw.z / uLen };
  const v = {
    x: nn.y * u.z - nn.z * u.y,
    y: nn.z * u.x - nn.x * u.z,
    z: nn.x * u.y - nn.y * u.x,
  };
  const pts: Point3[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 2) * (i / 5);
    const c = Math.cos(a) * RADIUS;
    const s = Math.sin(a) * RADIUS;
    pts.push({
      x: CENTER.x + u.x * c + v.x * s,
      y: CENTER.y + u.y * c + v.y * s,
      z: CENTER.z + u.z * c + v.z * s,
    });
  }
  return pts;
}

/** Points on a genuinely straight, off-origin, non-axis-aligned run —
 *  the "tessellation-fragment" shape #2199 actually reported, not a
 *  synthetic axis-aligned line. */
function straightPoints(): Point3[] {
  const dir = { x: 3, y: -1, z: 2 };
  const start = { x: 15.5, y: 4.2, z: -8.9 };
  return [0, 0.6, 1.3, 2.1, 3].map((t) => ({
    x: start.x + dir.x * t,
    y: start.y + dir.y * t,
    z: start.z + dir.z * t,
  }));
}

describe('handleRadiusClick wiring (#2737 item 2)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      measureMode: 'radius',
      activeRadius: null,
      radiusMeasurements: [],
      activeMeasurement: null,
    });
  });

  it('a miss is a no-op, matching polyline/angle', () => {
    handleRadiusClick(fakeCtx(null), 10, 10);
    assert.equal(useViewerStore.getState().activeRadius, null);
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 0);
  });

  it('a click registers a pick — the tool is not dead', () => {
    // Kills the "replace the handler body with `return`" mutation.
    handleRadiusClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    assert.equal(useViewerStore.getState().activeRadius?.points.length, 1);
  });

  it('accumulates every click into ONE growing sequence (no fixed count)', () => {
    arcPoints().forEach((p, i) => handleRadiusClick(fakeCtx(p), i * 50, i * 50));
    assert.equal(useViewerStore.getState().activeRadius?.points.length, 6);
    assert.equal(useViewerStore.getState().radiusMeasurements.length, 0, 'radius never finishes itself');
  });

  it('a genuine off-origin, tilted arc finishes with a FITTED radius and its provenance', () => {
    const pts = arcPoints();
    pts.forEach((p, i) => handleRadiusClick(fakeCtx(p), i * 50, i * 50));
    // Enter-equivalent finish (no double-click involved) — the dedicated
    // double-click dedup behaviour is covered by
    // measurementSlice.radius.test.ts.
    useViewerStore.getState().finishRadius();

    const finished = useViewerStore.getState().radiusMeasurements;
    assert.equal(finished.length, 1, 'the finish gesture must record a measurement');
    const readout = readoutOf(finished[0].points);
    assert.match(readout, /^R 3\.200 m \/ D 6\.400 m \(fitted from 6 tessellation points\)$/,
      `expected a fitted radius with its provenance label, got: ${readout}`);
  });

  it('a straight, off-axis run refuses VISIBLY — not blank, not a stale reading', () => {
    const pts = straightPoints();
    pts.forEach((p, i) => handleRadiusClick(fakeCtx(p), i * 50, i * 50));
    useViewerStore.getState().finishRadius();

    const finished = useViewerStore.getState().radiusMeasurements;
    assert.equal(finished.length, 1);
    const readout = readoutOf(finished[0].points);
    // Kills a mutation that reports a fitted circle for a straight run: the
    // readout must be the explicit refusal string, not a number with units.
    assert.equal(readout, 'Not circular (straight)');
    assert.doesNotMatch(readout, /^R \d/, 'a straight run must never render as a numeric radius');
  });

  it('the two refusal reasons render as DISTINCT strings, not collapsed into one', () => {
    // no-curvature: straight run, caught before a fit is even attempted.
    const straight = readoutOf(straightPoints());
    // poor-fit: curved but not circularly so — an S-bend built from two
    // opposite-bulge arcs sharing an endpoint, off-origin and off-axis.
    const bulge = (sign: number, base: Point3): Point3[] => {
      const r = 5;
      return [0, 0.4, 0.8, 1.2].map((t) => ({
        x: base.x + t * 10,
        y: base.y + sign * Math.sin(t) * r,
        z: base.z + t * 3,
      }));
    };
    const sBend = [
      ...bulge(1, { x: 8.1, y: -3.4, z: 6.6 }),
      ...bulge(-1, { x: 18.1, y: -3.4, z: 18.6 }),
    ];
    const poorFit = readoutOf(sBend);

    assert.equal(straight, 'Not circular (straight)');
    assert.notEqual(poorFit, straight, 'no-curvature and poor-fit must not collapse into the same string');
    assert.notEqual(poorFit, '-', 'a refusal must be spelled out, not a bare dash');
    assert.notEqual(straight, '-', 'a refusal must be spelled out, not a bare dash');
  });

  it('finishRadiusFromDoubleClick is null outside radius mode / without a sequence', () => {
    assert.equal(finishRadiusFromDoubleClick(), null, 'no active sequence — not this gesture');
    handleRadiusClick(fakeCtx({ x: 0, y: 0, z: 0 }), 0, 0);
    useViewerStore.setState({ measureMode: 'polyline' });
    assert.equal(
      finishRadiusFromDoubleClick(),
      null,
      'a sequence exists but the tool has left radius mode — still not this gesture',
    );
  });

  it('finishRadiusFromDoubleClick records a real double-click finish on a genuine arc', () => {
    const pts = arcPoints();
    pts.forEach((p, i) => handleRadiusClick(fakeCtx(p), i * 50, i * 50));
    // The browser's second click of the physical double-click: same world
    // point as the last pick, so its SCREEN coordinates land within the
    // duplicate guard's radius of it.
    handleRadiusClick(fakeCtx(pts[pts.length - 1]), 0, 0);
    const recorded = finishRadiusFromDoubleClick();
    assert.equal(recorded, true);
    const finished = useViewerStore.getState().radiusMeasurements;
    assert.equal(finished.length, 1);
    assert.equal(finished[0].points.length, 6, 'the duplicate half of the double-click must be dropped');
  });
});
