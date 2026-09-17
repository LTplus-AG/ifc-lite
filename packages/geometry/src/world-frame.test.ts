/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared render frame -> IFC world conversion (#4879). Every BCF
 * producer (viewer, CLI, MCP playground, SDK) adds this offset to a Z-up
 * render-frame position, so it has to fold BOTH recorded shifts in, each in
 * its own axes.
 */

import { describe, expect, it } from 'vitest';
import type { CoordinateInfo, Vec3 } from './coordinate-types.js';
import { resolveRtcFrame } from './rtc-frame.js';
import { rebaseGeometryOntoFirstRealAnchor } from './rtc-rebase.js';
import {
  chooseSharedRtcOffset,
  federationFrameInfo,
  ifcToViewerAxes,
  renderFrameWorldOffset,
  totalYupOffset,
  viewerToIfcAxes,
} from './world-frame.js';

/** The #4806 reporter's site, as the wasm pre-pass reports it (IFC Z-up). */
const RTC_IFC = { x: 41266.679, y: 308208.972, z: 125.95 };
/** A further CoordinateHandler shift, recorded in Y-up mesh axes. */
const SHIFT_YUP = { x: 1800, y: -35, z: -2600 };

function info(partial: Partial<CoordinateInfo>): CoordinateInfo {
  const box = { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  return {
    originShift: { x: 0, y: 0, z: 0 },
    originalBounds: box,
    shiftedBounds: box,
    hasLargeCoordinates: false,
    ...partial,
  };
}

describe('renderFrameWorldOffset', () => {
  it('adds the RTC offset as-is and the Y-up origin shift converted to Z-up', () => {
    const offset = renderFrameWorldOffset(info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC }));
    // Y-up (x, y, z) is IFC (x, -z, y): the shift's -2600 "towards the viewer"
    // is +2600 north, and its -35 "up" is -35 height.
    expect(offset.x).toBeCloseTo(RTC_IFC.x + 1800, 9);
    expect(offset.y).toBeCloseTo(RTC_IFC.y + 2600, 9);
    expect(offset.z).toBeCloseTo(RTC_IFC.z - 35, 9);
  });

  it('maps a render-frame point to its world position', () => {
    const frame = info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC });
    // World point, into the render frame the way the mesher does it:
    // subtract the RTC offset in IFC axes, swap to Y-up, subtract the shift.
    const world = { x: RTC_IFC.x + 1812, y: RTC_IFC.y + 2590, z: RTC_IFC.z - 30 };
    const yup = ifcToViewerAxes({ x: world.x - RTC_IFC.x, y: world.y - RTC_IFC.y, z: world.z - RTC_IFC.z });
    const render = viewerToIfcAxes({ x: yup.x - SHIFT_YUP.x, y: yup.y - SHIFT_YUP.y, z: yup.z - SHIFT_YUP.z });
    const offset = renderFrameWorldOffset(frame);
    expect(render.x + offset.x).toBeCloseTo(world.x, 6);
    expect(render.y + offset.y).toBeCloseTo(world.y, 6);
    expect(render.z + offset.z).toBeCloseTo(world.z, 6);
  });

  it('is exactly zero, with no negative zero, for an unshifted or unknown frame', () => {
    for (const frame of [undefined, null, info({}), { originShift: null, wasmRtcOffset: null }]) {
      const offset = renderFrameWorldOffset(frame);
      expect(Object.is(offset.x, 0) && Object.is(offset.y, 0) && Object.is(offset.z, 0)).toBe(true);
    }
  });

  it('agrees with totalYupOffset, the viewer-axes form', () => {
    const frame = info({ originShift: SHIFT_YUP, wasmRtcOffset: RTC_IFC });
    expect(renderFrameWorldOffset(frame)).toEqual(viewerToIfcAxes(totalYupOffset(frame)));
  });
});

describe('federationFrameInfo', () => {
  const anchor = info({ wasmRtcOffset: RTC_IFC });
  const later = info({ wasmRtcOffset: { x: 1, y: 2, z: 3 } });

  it('picks the earliest-loaded model with geometry, whatever the iteration order', () => {
    const models = [
      { loadedAt: 20, geometryResult: { coordinateInfo: later } },
      { loadedAt: 5, geometryResult: null },
      { loadedAt: 10, geometryResult: { coordinateInfo: anchor } },
    ];
    expect(federationFrameInfo(models)).toBe(anchor);
  });

  it('falls back to a single legacy geometry result, and to null', () => {
    expect(federationFrameInfo([], { coordinateInfo: anchor })).toBe(anchor);
    expect(federationFrameInfo([{ loadedAt: 1, geometryResult: { coordinateInfo: later } }], { coordinateInfo: anchor })).toBe(later);
    expect(federationFrameInfo([])).toBeNull();
  });
});

describe('chooseSharedRtcOffset', () => {
  it('is undefined with no earlier models — the loading model is the first one', () => {
    expect(chooseSharedRtcOffset([])).toBeUndefined();
  });

  it('is undefined when every earlier model has no wasmRtcOffset (raw frame)', () => {
    const raw = info({});
    const models = [
      { loadedAt: 1, geometryResult: { coordinateInfo: raw } },
      { loadedAt: 2, geometryResult: { coordinateInfo: raw } },
    ];
    expect(chooseSharedRtcOffset(models)).toBeUndefined();
  });

  it('picks the earliest-loaded offset, whatever the iteration order', () => {
    const anchor = info({ wasmRtcOffset: RTC_IFC });
    const laterOffset = info({ wasmRtcOffset: { x: 1, y: 2, z: 3 } });
    const models = [
      { loadedAt: 20, geometryResult: { coordinateInfo: laterOffset } },
      { loadedAt: 5, geometryResult: null },
      { loadedAt: 10, geometryResult: { coordinateInfo: anchor } },
    ];
    expect(chooseSharedRtcOffset(models)).toEqual(RTC_IFC);
  });
});

/**
 * The #4897 order-permutation test. A has small coordinates and no
 * `wasmRtcOffset`; B has large, non-round, asymmetric-sign coordinates and a
 * real one. Loading {A, B} in either order must converge on the identical
 * federation frame, and that frame must be the one actually baked into
 * EVERY model's mesh — not just a report both orders happen to agree on.
 *
 * This exercises the full production rule end to end: `chooseSharedRtcOffset`
 * picks the frame a new model joins, `resolveRtcFrame` is the mesh path's
 * own frame resolution (rtc-frame.ts), and `rebasePositionsToRtcOffset` is
 * what `useIfcFederation.ts` applies to an already-loaded, still-raw model
 * the moment a later model introduces the federation's first real anchor.
 */
describe('#4897 order-permutation: A (small, no offset) then/after B (large, real offset)', () => {
  /** B's real detected IFC anchor: non-round, asymmetric sign, like the repro. */
  const B_ANCHOR: Vec3 = { x: 2_000_000.375, y: -1_000_000.625, z: 500.125 };
  /** A's world point: near the origin, non-round. */
  const WORLD_A: Vec3 = { x: 3.25, y: -1.5, z: 0.75 };
  /** B's world point: B's anchor plus a small local offset, non-round. */
  const WORLD_B: Vec3 = { x: B_ANCHOR.x + 4.5, y: B_ANCHOR.y - 2.25, z: B_ANCHOR.z + 1.125 };

  interface SimModel {
    loadedAt: number;
    positions: Float32Array;
    geometryResult: { coordinateInfo: CoordinateInfo; meshes: Array<{ positions: Float32Array }> };
  }

  /** Load one model against `existing`, exactly like the WASM mesh path does. */
  function loadOne(loadedAt: number, detectedOffset: Vec3 | undefined, worldPointIfc: Vec3, existing: SimModel[]): SimModel {
    const sharedRtcOffset = chooseSharedRtcOffset(existing);
    const detected = detectedOffset
      ? { rtcOffset: [detectedOffset.x, detectedOffset.y, detectedOffset.z], needsShift: true }
      : { rtcOffset: null, needsShift: false };
    const frame = resolveRtcFrame(detected, sharedRtcOffset);
    const appliedIfc: Vec3 = frame.needsShift ? { x: frame.x, y: frame.y, z: frame.z } : { x: 0, y: 0, z: 0 };
    const localIfc = {
      x: worldPointIfc.x - appliedIfc.x,
      y: worldPointIfc.y - appliedIfc.y,
      z: worldPointIfc.z - appliedIfc.z,
    };
    const yup = ifcToViewerAxes(localIfc);
    const positions = new Float32Array([yup.x, yup.y, yup.z]);
    return {
      loadedAt,
      positions,
      geometryResult: {
        coordinateInfo: info({ wasmRtcOffset: frame.needsShift ? appliedIfc : undefined }),
        meshes: [{ positions }],
      },
    };
  }

  /**
   * The production re-basing step, calling the EXACT function
   * `useIfcFederation.ts` calls: when the just-loaded model introduced the
   * federation's FIRST real anchor, every already-loaded model that was
   * still in the raw frame joins it too.
   */
  function rebaseIfFirstRealAnchor(existing: SimModel[], justLoaded: SimModel): void {
    const newOffset = justLoaded.geometryResult.coordinateInfo.wasmRtcOffset;
    rebaseGeometryOntoFirstRealAnchor(existing.map((m) => m.geometryResult), newOffset ?? null);
  }

  function simulate(order: 'A-then-B' | 'B-then-A') {
    const models: SimModel[] = [];
    const seq: Array<[string, number, Vec3 | undefined, Vec3]> = order === 'A-then-B'
      ? [['A', 1, undefined, WORLD_A], ['B', 2, B_ANCHOR, WORLD_B]]
      : [['B', 1, B_ANCHOR, WORLD_B], ['A', 2, undefined, WORLD_A]];
    const byName: Record<string, SimModel> = {};
    for (const [name, loadedAt, detected, worldPt] of seq) {
      const model = loadOne(loadedAt, detected, worldPt, models);
      rebaseIfFirstRealAnchor(models, model);
      models.push(model);
      byName[name] = model;
    }
    return { models, A: byName.A, B: byName.B };
  }

  /** Recover a rendered vertex's IFC world position via `federationFrameInfo`. */
  function worldOf(model: SimModel, frame: CoordinateInfo | null): Vec3 {
    const p = model.positions;
    const render = viewerToIfcAxes({ x: p[0], y: p[1], z: p[2] });
    const offset = renderFrameWorldOffset(frame);
    return { x: render.x + offset.x, y: render.y + offset.y, z: render.z + offset.z };
  }

  it('converges on the identical frame in both orders, applied to every model', () => {
    const ab = simulate('A-then-B');
    const ba = simulate('B-then-A');

    const frameAB = federationFrameInfo(ab.models);
    const frameBA = federationFrameInfo(ba.models);

    // The reported frame is the literal same value in both orders — not
    // just "both orders self-consistent" but the actual chosen anchor.
    expect(frameAB?.wasmRtcOffset).toEqual(B_ANCHOR);
    expect(frameBA?.wasmRtcOffset).toEqual(B_ANCHOR);
    expect(frameAB?.wasmRtcOffset).toEqual(frameBA?.wasmRtcOffset);

    // The reported frame is what is ACTUALLY applied to every model, in
    // both orders — two wrong values that merely agree is the failure mode
    // this guards against, not just report-vs-report equality.
    for (const { models } of [ab, ba]) {
      const reported = federationFrameInfo(models);
      for (const model of models) {
        expect(model.geometryResult.coordinateInfo.wasmRtcOffset).toEqual(reported?.wasmRtcOffset);
      }
    }
  });

  it('recovers the correct, order-independent world position for both A and B', () => {
    const ab = simulate('A-then-B');
    const ba = simulate('B-then-A');
    const frameAB = federationFrameInfo(ab.models);
    const frameBA = federationFrameInfo(ba.models);

    const bWorldAB = worldOf(ab.B, frameAB);
    const bWorldBA = worldOf(ba.B, frameBA);
    expect(bWorldAB.x).toBeCloseTo(WORLD_B.x, 3);
    expect(bWorldAB.y).toBeCloseTo(WORLD_B.y, 3);
    expect(bWorldAB.z).toBeCloseTo(WORLD_B.z, 3);
    expect(bWorldBA).toEqual(bWorldAB);

    const aWorldAB = worldOf(ab.A, frameAB);
    const aWorldBA = worldOf(ba.A, frameBA);
    expect(aWorldAB.x).toBeCloseTo(WORLD_A.x, 3);
    expect(aWorldAB.y).toBeCloseTo(WORLD_A.y, 3);
    expect(aWorldAB.z).toBeCloseTo(WORLD_A.z, 3);
    expect(aWorldBA).toEqual(aWorldAB);

    // The distance between A and B, in the render frame, must be the same
    // huge separation in both orders — not zero (the pre-fix A-first bug
    // drew A and B on top of each other at the render-frame origin).
    const dx = ab.A.positions[0] - ab.B.positions[0];
    const dy = ab.A.positions[1] - ab.B.positions[1];
    const dz = ab.A.positions[2] - ab.B.positions[2];
    const distAB = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const dx2 = ba.A.positions[0] - ba.B.positions[0];
    const dy2 = ba.A.positions[1] - ba.B.positions[1];
    const dz2 = ba.A.positions[2] - ba.B.positions[2];
    const distBA = Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
    expect(distAB).toBeGreaterThan(1_000_000);
    expect(distBA).toBeCloseTo(distAB, 3);
  });
});
