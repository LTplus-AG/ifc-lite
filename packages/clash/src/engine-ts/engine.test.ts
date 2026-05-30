/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { createClashEngine } from '../engine.js';
import { makeExclusionSet, qualifiedKey } from '../exclude.js';
import { fromPositions } from '../math/aabb.js';
import type { ClashElement, ClashRule, Vec3 } from '../types.js';

/** Axis-aligned cube as a triangle mesh (12 triangles). */
function makeBox(center: Vec3, size: number): { positions: Float32Array; indices: Uint32Array } {
  const h = size / 2;
  const [cx, cy, cz] = center;
  const v: number[] = [
    cx - h, cy - h, cz - h,
    cx + h, cy - h, cz - h,
    cx + h, cy + h, cz - h,
    cx - h, cy + h, cz - h,
    cx - h, cy - h, cz + h,
    cx + h, cy - h, cz + h,
    cx + h, cy + h, cz + h,
    cx - h, cy + h, cz + h,
  ];
  const indices = new Uint32Array([
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ]);
  return { positions: new Float32Array(v), indices };
}

let nextRef = 1;
function boxElement(key: string, tag: string, center: Vec3, size = 1): ClashElement {
  const { positions, indices } = makeBox(center, size);
  return {
    key,
    ref: nextRef++,
    model: 'm',
    tag,
    bounds: fromPositions(positions),
    positions,
    indices,
  };
}

const engine = createClashEngine({ backend: 'ts' });
const hard = (over: Partial<ClashRule> = {}): ClashRule => ({
  id: 'r',
  name: 'rule',
  a: 'IfcWall',
  b: 'IfcDuct',
  mode: 'hard',
  ...over,
});

describe('TsClashEngine', () => {
  it('detects a hard clash between overlapping elements', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const result = await engine.run(elements, [hard()]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].status).toBe('hard');
    expect(result.clashes[0].distance).toBeLessThan(0);
    expect(result.summary.byRule.r).toBe(1);
  });

  it('reports no clash for separated elements in hard mode', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [2, 0, 0]),
    ];
    const result = await engine.run(elements, [hard()]);
    expect(result.summary.total).toBe(0);
  });

  it('finds a clearance violation within the gap, not outside it', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [2, 0, 0]), // 1.0 m face-to-face gap
    ];
    const tooTight = await engine.run(elements, [hard({ mode: 'clearance', clearance: 0.5 })]);
    expect(tooTight.summary.total).toBe(0);

    const wide = await engine.run(elements, [hard({ mode: 'clearance', clearance: 1.5 })]);
    expect(wide.summary.total).toBe(1);
    expect(wide.clashes[0].status).toBe('clearance');
    expect(wide.clashes[0].distance).toBeCloseTo(1.0, 3);
  });

  it('suppresses touching elements unless reportTouch is set', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [1, 0, 0]), // faces meet at x = 0.5
    ];
    const suppressed = await engine.run(elements, [hard()]);
    expect(suppressed.summary.total).toBe(0);

    const reported = await engine.run(elements, [hard({ reportTouch: true })]);
    expect(reported.summary.total).toBe(1);
    expect(reported.clashes[0].status).toBe('touch');
  });

  it('honors the exclusion set', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const exclusions = makeExclusionSet([[qualifiedKey('m', 'A'), qualifiedKey('m', 'B')]]);
    const result = await engine.run(elements, [hard()], { exclusions });
    expect(result.summary.total).toBe(0);
  });

  it('runs a self-clash within one selection', async () => {
    const elements = [
      boxElement('A', 'IfcBeam', [0, 0, 0]),
      boxElement('B', 'IfcBeam', [0.5, 0, 0]), // overlaps A
      boxElement('C', 'IfcBeam', [10, 0, 0]), // far away
    ];
    const result = await engine.run(elements, [
      { id: 'self', name: 'beam self-clash', a: 'IfcBeam', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(1);
  });

  it('infers severity from the discipline matrix when not given', async () => {
    const elements = [
      boxElement('A', 'IfcDuctSegment', [0, 0, 0]),
      boxElement('B', 'IfcBeam', [0.5, 0, 0]),
    ];
    const result = await engine.run(elements, [
      { id: 'hvac-str', name: 'HVAC vs STR', a: 'IfcDuct*', b: 'IfcBeam', mode: 'hard' },
    ]);
    expect(result.summary.total).toBe(1);
    expect(result.clashes[0].severity).toBe('critical');
  });

  it('produces deterministic, stable clash ids and ordering', async () => {
    const build = () => [
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
      boxElement('A', 'IfcWall', [0, 0, 0]),
    ];
    const first = await engine.run(build(), [hard()]);
    const second = await engine.run(build(), [hard()]);
    expect(first.clashes[0].id).toBe(second.clashes[0].id);
  });

  it('throws when the abort signal is already aborted', async () => {
    const elements = [
      boxElement('A', 'IfcWall', [0, 0, 0]),
      boxElement('B', 'IfcDuct', [0.5, 0, 0]),
    ];
    const controller = new AbortController();
    controller.abort();
    await expect(engine.run(elements, [hard()], { signal: controller.signal })).rejects.toThrow();
  });
});
