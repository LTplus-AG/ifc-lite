/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Roof by footprint planes (#9296 round 3), against invariants a roof has
 * whatever algorithm drew it: the planes tile the footprint, each rises at its
 * edge's slope from its pivot line, neighbours meet without a step, a convex
 * roof is the lower envelope of its planes, and the rises match the textbook
 * values the parity probe asks for (10 × 8 m: hip and gable 4·tan30, mono 8·tan10).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { FootprintRoofPlan, PlanPoint } from './roof-footprint-plan.js';
import { requiredModule } from './__test__/required-module.js';

/** Loaded per test, so a revert of the planner fails these assertions rather than this file's load. */
let m: typeof import('./roof-footprint-plan.js');
beforeEach(async () => { m = await requiredModule(() => import('./roof-footprint-plan.js'), 'the roof-by-footprint planner exists (#9296)'); });

const D = Math.PI / 180;
const RECT: PlanPoint[] = [[0, 0], [10, 0], [10, 8], [0, 8]];
const planArea = (plan: FootprintRoofPlan) => plan.planes.reduce((sum, p) => sum + m.signedArea(p.outline), 0);
const slopedArea = (plan: FootprintRoofPlan) => plan.planes.reduce((sum, p) => sum + m.signedArea(p.outline) / Math.cos(p.slope), 0);

/** Every corner shared in plan by two planes has one height: the roof has no step. */
function expectWatertight(plan: FootprintRoofPlan) {
  const corners = plan.planes.flatMap((plane) => plane.outline.map((p) => ({ p, z: m.heightAt(plane, p) })));
  for (const a of corners) {
    for (const b of corners) {
      if (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1]) < 1e-7) expect(Math.abs(a.z - b.z)).toBeLessThan(1e-7);
    }
  }
}

describe('planFootprintRoof (#9296 round 3)', () => {
  it('a hip roof on 10 × 8 m at 30° rises 4·tan30 to a 2 m ridge, in four planes tiling the footprint', () => {
    const plan = m.planFootprintRoof(RECT, [30 * D, 30 * D, 30 * D, 30 * D], 0);
    expect(plan.shapeType).toBe('HIP_ROOF');
    expect(plan.planes).toHaveLength(4);
    expect(plan.rise).toBeCloseTo(4 * Math.tan(30 * D), 9);
    expect(planArea(plan)).toBeCloseTo(80, 9);
    expect(slopedArea(plan)).toBeCloseTo(80 / Math.cos(30 * D), 9);
    const ridge = plan.planes.flatMap((p) => p.outline).filter((p) => Math.abs(p[1] - 4) < 1e-9 && p[0] > 0.1 && p[0] < 9.9);
    expect(Math.max(...ridge.map((p) => p[0])) - Math.min(...ridge.map((p) => p[0]))).toBeCloseTo(2, 9);
    expectWatertight(plan);
  });

  it('a gable roof slopes its long edges and stops on vertical gable ends', () => {
    const plan = m.planFootprintRoof(RECT, [30 * D, 0, 30 * D, 0], 0);
    expect(plan.shapeType).toBe('GABLE_ROOF');
    expect(plan.planes.map((p) => p.edge)).toEqual([0, 2]);
    expect(plan.rise).toBeCloseTo(4 * Math.tan(30 * D), 9);
    for (const plane of plan.planes) expect(m.signedArea(plane.outline)).toBeCloseTo(40, 9);
    expectWatertight(plan);
  });

  it('a three-plane rectangle is not a two-plane gable (#9356 review)', () => {
    const plan = planFootprintRoof(RECT, [0.5, 0.5, 0.5, 0], 0);
    expect(plan.planes).toHaveLength(3);
    expect(plan.shapeType).toBe('FREEFORM');
  });

  it('a mono-pitch roof rises across the whole depth to its high side', () => {
    const plan = m.planFootprintRoof(RECT, [10 * D, 0, 0, 0], 0);
    expect(plan.shapeType).toBe('SHED_ROOF');
    expect(plan.planes).toHaveLength(1);
    expect(plan.rise).toBeCloseTo(8 * Math.tan(10 * D), 9);
    expect(planArea(plan)).toBeCloseTo(80, 9);
  });

  it('the FZK-Haus gable (12 × 10 m, 30°, 0.5 m overhang) has the reference model\'s 165.12 m² of roof', () => {
    const plan = m.planFootprintRoof([[0, 0], [12, 0], [12, 10], [0, 10]], [30 * D, 0, 30 * D, 0], 0.5);
    expect(slopedArea(plan)).toBeCloseTo(165.12, 2);
    // Eaves drop with their plane; gable ends carry the rake out as far.
    const all = plan.planes.flatMap((p) => p.outline);
    expect(Math.min(...all.map((p) => p[0]))).toBeCloseTo(-0.5, 9);
    expect(Math.min(...plan.planes.flatMap((plane) => plane.outline.map((p) => m.heightAt(plane, p))))).toBeCloseTo(-0.5 * Math.tan(30 * D), 9);
    expect(plan.rise).toBeCloseTo(5 * Math.tan(30 * D), 9);
  });

  it('a convex footprint with a different slope per edge is the lower envelope of its planes', () => {
    const hexagon: PlanPoint[] = [[0, 0], [6, -1], [10, 2], [9, 7], [3, 8], [-1, 4]];
    const slopes = [20, 45, 30, 35, 25, 50].map((a) => a * D);
    const plan = m.planFootprintRoof(hexagon, slopes, 0);
    expect(planArea(plan)).toBeCloseTo(m.signedArea(hexagon), 9);
    const all = plan.planes.map((p) => p);
    for (const plane of plan.planes) {
      for (const p of plane.outline) {
        const own = m.heightAt(plane, p);
        for (const other of all) expect(m.heightAt(other, p)).toBeGreaterThanOrEqual(own - 1e-7);
      }
    }
    expectWatertight(plan);
  });

  it.each([
    ['an L hip', [[0, 0], [10, 0], [10, 4], [6, 4], [6, 10], [0, 10]] as PlanPoint[], [1, 1, 1, 1, 1, 1], 3],
    ['an L with gable wing ends', [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]] as PlanPoint[], [1, 0, 1, 1, 0, 1], 2],
    ['a T', [[4, 0], [8, 0], [8, 6], [12, 6], [12, 10], [0, 10], [0, 6], [4, 6]] as PlanPoint[], [1, 1, 1, 1, 1, 1, 1, 1], 2],
    ['a U', [[0, 0], [10, 0], [10, 10], [7, 10], [7, 4], [3, 4], [3, 10], [0, 10]] as PlanPoint[], [1, 1, 1, 1, 1, 1, 1, 1], 2],
    // A narrow bar between two arms: its reflex corners run into the far edges (split events).
    ['an H', [[0, 0], [2, 0], [2, 4], [8, 4], [8, 0], [10, 0], [10, 10], [8, 10], [8, 5], [2, 5], [2, 10], [0, 10]] as PlanPoint[], Array(12).fill(1), 1],
    ['a stepped outline', [[0, 0], [9, 0], [9, 3], [6, 3], [6, 6], [3, 6], [3, 9], [0, 9]] as PlanPoint[], Array(8).fill(1), 3],
  ])('rectilinear: %s tiles its footprint and reaches its widest wing\'s ridge', (_name, footprint, flags, halfWidth) => {
    const slopes = flags.map((f) => f * 45 * D);
    const plan = m.planFootprintRoof(footprint, slopes, 0);
    expect(planArea(plan)).toBeCloseTo(m.signedArea(footprint), 9);
    expect(plan.rise).toBeCloseTo(halfWidth, 9);
    for (const plane of plan.planes) for (const p of plane.outline) expect(m.heightAt(plane, p)).toBeGreaterThanOrEqual(-1e-9);
    expectWatertight(plan);
  });

  it('an L hip with an overhang keeps its eaves level and its valley at the inside corner', () => {
    const footprint: PlanPoint[] = [[0, 0], [10, 0], [10, 4], [6, 4], [6, 10], [0, 10]];
    const plan = m.planFootprintRoof(footprint, footprint.map(() => 30 * D), 0.4);
    const eaveHeight = -0.4 * Math.tan(30 * D);
    for (const plane of plan.planes) for (const p of plane.outline) expect(m.heightAt(plane, p)).toBeGreaterThanOrEqual(eaveHeight - 1e-9);
    expect(planArea(plan)).toBeCloseTo(m.signedArea(plan.eaves), 9);
    expectWatertight(plan);
  });

  it('a clockwise footprint gives the same roof, with each plane named by the caller\'s edge', () => {
    const cw = [...RECT].reverse();
    // Reversed, the caller's edge 0 runs (0,8)→(10,8): slope it and the opposite edge.
    const plan = m.planFootprintRoof(cw, [30 * D, 0, 30 * D, 0], 0);
    expect(plan.planes.map((p) => p.edge).sort()).toEqual([0, 2]);
    expect(plan.rise).toBeCloseTo(4 * Math.tan(30 * D), 9);
  });

  it('a point on a straight run with one slope is one edge', () => {
    const plan = m.planFootprintRoof([[0, 0], [5, 0], [10, 0], [10, 8], [0, 8]], [30 * D, 30 * D, 0, 30 * D, 0], 0);
    expect(plan.planes).toHaveLength(2);
    expect(plan.shapeType).toBe('GABLE_ROOF');
  });

  it('a gable end split into two collinear edges is still a gable roof (#9356 review)', () => {
    const plan = m.planFootprintRoof([[0, 0], [10, 0], [10, 4], [10, 8], [0, 8]], [0.5, 0, 0, 0.5, 0], 0);
    expect(plan.shapeType).toBe('GABLE_ROOF');
    expect(plan.planes).toHaveLength(2);
  });

  it('no sloped edge is a flat roof over the eaves', () => {
    const plan = m.planFootprintRoof(RECT, [0, 0, 0, 0], 0.5);
    expect(plan.shapeType).toBe('FLAT_ROOF');
    expect(plan.planes).toHaveLength(0);
    expect(m.signedArea(plan.eaves)).toBeCloseTo(11 * 9, 9);
  });

  it.each([
    ['degrees passed as radians', RECT, [30, 30, 30, 30], 0, /slopes are radians/],
    ['too steep', RECT, [86 * D, 0, 30 * D, 0], 0, /steeper than 85°/],
    ['one slope short', RECT, [30 * D, 0, 30 * D], 0, /one slope per footprint edge/],
    ['a crossing outline', [[0, 0], [10, 8], [10, 0], [0, 8]] as PlanPoint[], [1, 1, 1, 1], 0, /crosses itself/],
    ['an inside corner that is not square', [[0, 0], [10, 0], [10, 8], [5, 3], [0, 8]] as PlanPoint[], [0.5, 0.5, 0.5, 0.5, 0.5], 0, /convex and rectilinear/],
    ['an overhang wider than the notch', [[0, 0], [10, 0], [10, 10], [7, 10], [7, 4], [6, 4], [6, 10], [0, 10]] as PlanPoint[], Array(8).fill(0.5), 0.6, /too large/],
    ['unequal slopes at an inside corner under an overhang', [[0, 0], [10, 0], [10, 4], [6, 4], [6, 10], [0, 10]] as PlanPoint[], [0.5, 0.5, 0.3, 0.5, 0.5, 0.5], 0.2, /inside corner need/],
    ['collinear edges with different slopes', [[0, 0], [5, 0], [10, 0], [10, 8], [0, 8]] as PlanPoint[], [0.5, 0.3, 0, 0.5, 0], 0, /in line but have different slopes/],
    ['a negative overhang', RECT, [0.5, 0.5, 0.5, 0.5], -1, /Overhang/],
    ['a footprint with no area (#9356 review)', [[0, 0], [5, 0], [10, 0]] as PlanPoint[], [0, 0, 0], 0, /encloses no area/],
  ])('refuses %s with a reason', (_name, footprint, slopes, overhang, reason) => {
    expect(() => m.planFootprintRoof(footprint, slopes, overhang)).toThrow(reason);
  });

  it('names the predefined type from the slopes alone', () => {
    expect(m.roofShapeType([0, 0, 0])).toBe('FLAT_ROOF');
    expect(m.roofShapeType([1, 0, 0, 0])).toBe('SHED_ROOF');
    expect(m.roofShapeType([1, 0, 1, 0])).toBe('GABLE_ROOF');
    expect(m.roofShapeType([1, 1, 1, 1])).toBe('HIP_ROOF');
    expect(m.roofShapeType([1, 1, 0, 0])).toBe('FREEFORM');
  });
});
