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
import { convergeGeometryOntoRtcAnchor } from './rtc-rebase.js';
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

  it('prefers the earliest ANCHORED model over an earlier raw one (#4897)', () => {
    // A near-origin model or a raw point cloud loaded first must not define
    // the reported frame once an anchored model is present: the loader moves
    // every meshed model onto that anchor, and point clouds never join it.
    const raw = info({});
    const models = [
      { loadedAt: 1, geometryResult: { coordinateInfo: raw } },
      { loadedAt: 30, geometryResult: { coordinateInfo: later } },
      { loadedAt: 20, geometryResult: { coordinateInfo: anchor } },
    ];
    expect(federationFrameInfo(models)).toBe(anchor);
  });

  it('does not let a still-streaming anchored model define the frame before it settles', () => {
    // Overlapping loads: the settled raw model has not been converged onto the
    // streaming model's anchor yet, so that anchor is not the frame in use.
    const raw = info({});
    const models = [
      { loadedAt: 1, geometryResult: { coordinateInfo: raw } },
      { loadedAt: 0, loadState: 'streaming-geometry', geometryResult: { coordinateInfo: anchor } },
    ];
    expect(federationFrameInfo(models)).toBe(raw);
    expect(federationFrameInfo([models[0], { ...models[1], loadState: 'complete' }])).toBe(anchor);
  });

  it('does not let a failed load define the frame either', () => {
    const raw = info({});
    const models = [
      { loadedAt: 1, geometryResult: { coordinateInfo: raw } },
      { loadedAt: 0, loadState: 'error', geometryResult: { coordinateInfo: anchor } },
    ];
    expect(federationFrameInfo(models)).toBe(raw);
  });

  it('falls back to the earliest raw model when no model is anchored', () => {
    const first = info({});
    const second = info({});
    const models = [
      { loadedAt: 2, geometryResult: { coordinateInfo: second } },
      { loadedAt: 1, geometryResult: { coordinateInfo: first } },
    ];
    expect(federationFrameInfo(models)).toBe(first);
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
 * own frame resolution (rtc-frame.ts), and `convergeGeometryOntoRtcAnchor` is
 * what the viewer applies to every settled model after each load. Meshes are
 * modelled the way the relativized wasm path emits them: an f64 element
 * `origin` plus small f32 local detail (1 mm here), so a rebase that narrowed
 * the anchor into f32 would collapse the detail and fail below.
 */
describe('#4897 order-permutation: A (small, no offset) then/after B (large, real offset)', () => {
  /** B's real detected IFC anchor: non-round, asymmetric sign, like the repro. */
  const B_ANCHOR: Vec3 = { x: 2_000_000.375, y: -1_000_000.625, z: 500.125 };
  /** A's world point: near the origin, non-round. */
  const WORLD_A: Vec3 = { x: 3.25, y: -1.5, z: 0.75 };
  /** B's world point: B's anchor plus a small local offset, non-round. */
  const WORLD_B: Vec3 = { x: B_ANCHOR.x + 4.5, y: B_ANCHOR.y - 2.25, z: B_ANCHOR.z + 1.125 };

  interface SimMesh { positions: Float32Array; origin?: [number, number, number] }
  interface SimModel {
    loadedAt: number;
    mesh: SimMesh;
    geometryResult: { coordinateInfo: CoordinateInfo; meshes: SimMesh[] };
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
    // f64 element origin, f32 local detail: two vertices 1 mm apart on X.
    const mesh: SimMesh = { origin: [yup.x, yup.y, yup.z], positions: new Float32Array([0, 0, 0, 0.001, 0, 0]) };
    return {
      loadedAt,
      mesh,
      geometryResult: {
        coordinateInfo: info({ wasmRtcOffset: frame.needsShift ? appliedIfc : undefined }),
        meshes: [mesh],
      },
    };
  }

  /** The viewer's post-load step: converge every loaded model onto the anchor. */
  function convergeAll(models: SimModel[]): void {
    const anchor = chooseSharedRtcOffset(models);
    if (anchor) convergeGeometryOntoRtcAnchor(models.map((m) => m.geometryResult), anchor);
  }

  function simulate(order: 'A-then-B' | 'B-then-A') {
    const models: SimModel[] = [];
    const seq: Array<[string, number, Vec3 | undefined, Vec3]> = order === 'A-then-B'
      ? [['A', 1, undefined, WORLD_A], ['B', 2, B_ANCHOR, WORLD_B]]
      : [['B', 1, B_ANCHOR, WORLD_B], ['A', 2, undefined, WORLD_A]];
    const byName: Record<string, SimModel> = {};
    for (const [name, loadedAt, detected, worldPt] of seq) {
      const model = loadOne(loadedAt, detected, worldPt, models);
      models.push(model);
      convergeAll(models);
      byName[name] = model;
    }
    return { models, A: byName.A, B: byName.B };
  }

  /** A rendered vertex in the render frame: f64 origin + f32 position. */
  function renderPoint(model: SimModel, vertex = 0): Vec3 {
    const o = model.mesh.origin ?? [0, 0, 0];
    const p = model.mesh.positions;
    return { x: o[0] + p[3 * vertex], y: o[1] + p[3 * vertex + 1], z: o[2] + p[3 * vertex + 2] };
  }

  /** Recover a rendered vertex's IFC world position via `federationFrameInfo`. */
  function worldOf(model: SimModel, frame: CoordinateInfo | null): Vec3 {
    const render = viewerToIfcAxes(renderPoint(model));
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

    // The render-frame separation of A and B is the same huge distance in
    // both orders, not zero (the pre-fix A-first bug drew them on top of each
    // other at the render-frame origin).
    const dist = (m: { A: SimModel; B: SimModel }) => {
      const a = renderPoint(m.A);
      const b = renderPoint(m.B);
      return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    };
    expect(dist(ab)).toBeGreaterThan(1_000_000);
    expect(dist(ba)).toBeCloseTo(dist(ab), 6);
  });

  it('keeps 1 mm of element detail exact on the rebased model in both orders', () => {
    for (const run of [simulate('A-then-B'), simulate('B-then-A')]) {
      for (const model of [run.A, run.B]) {
        const detail = renderPoint(model, 1).x - renderPoint(model, 0).x;
        expect(Math.abs(detail - 0.001)).toBeLessThan(1e-6);
      }
    }
  });
});
