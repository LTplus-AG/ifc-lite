/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Origin-shift invariance of the REPORTED touching result (#5639): TS
 * counterpart of `rust/clash/src/world_frame_tests.rs`, extended from the
 * verdict to what a user sees — `isTouching`, which the viewer's "hide
 * touching" filter and the triage summaries read.
 *
 * `isTouching` used to take its default band from the max |coordinate| of the
 * clash's bounds over all three axes. A model 10 km out in X gave a Z-direction
 * contact ~2.4 mm of slack from the X magnitude alone, so a genuine 1 mm
 * Z-overlap was listed as a real clash at the origin and hidden as "touching"
 * 10 km away. The engine now records each `hard` clash's own depth floor
 * (`Clash.depthFloor`, the classification floor from the clash-math source)
 * and `isTouching` bands on that.
 *
 * Scenes are authored in f64 near the origin, translated in f64, and baked
 * through f32, as ingestion does. The corpus offset (`WORLD_FRAME_OFFSET_M`,
 * along X) is orthogonal to the Z depth under test, per the corpus's own rule.
 * Both kernels are covered: this file drives the TS engine, and
 * `differential.test.ts` asserts the WASM kernel reports the same
 * `depthFloor` on every record.
 */

import { describe, expect, it } from 'vitest';
import { WORLD_FRAME_OFFSET_M } from '@ifc-lite/world-frame-fixtures';
import { isTouching } from '../analysis.js';
import { createClashEngine } from '../engine.js';
import type { ClashElement, ClashResult, ClashRule, Vec3 } from '../types.js';

const BOX_INDICES = new Uint32Array([
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 5, 1, 0, 4, 5, 3, 2, 6, 3, 6, 7, 0, 3, 7, 0, 7, 4,
  1, 5, 6, 1, 6, 2,
]);

const SIGNS: Vec3[] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** Axis-aligned box `centre ± half`, translated by `t` in f64, baked to f32. */
function box(key: string, tag: string, centre: Vec3, half: Vec3, t: Vec3): ClashElement {
  const positions = new Float32Array(24);
  SIGNS.forEach((s, i) => {
    for (let k = 0; k < 3; k += 1) positions[i * 3 + k] = centre[k]! + s[k]! * half[k]! + t[k]!;
  });
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 24; i += 1) {
    const k = i % 3;
    if (positions[i]! < min[k]!) min[k] = positions[i]!;
    if (positions[i]! > max[k]!) max[k] = positions[i]!;
  }
  return { key, ref: key.charCodeAt(0), model: 'm', tag, positions, indices: BOX_INDICES, bounds: { min, max } };
}

/** A 400 mm slab and a column standing on it, driven `overlap` into it along Z. */
function slabAndColumn(overlap: number, t: Vec3): ClashElement[] {
  return [
    box('S', 'IfcSlab', [2, 1, -0.2], [2.5, 1.5, 0.2], t),
    box('C', 'IfcColumn', [2, 1, 1.5 - overlap], [0.15, 0.15, 1.5], t),
  ];
}

const TRANSLATIONS: Vec3[] = [
  [0, 0, 0],
  [WORLD_FRAME_OFFSET_M, 0, 0],
  [0, WORLD_FRAME_OFFSET_M, 0],
  [1000, 0, 0],
  [123.456, -45.678, 0],
];

const RULE: ClashRule = { id: 'r', name: 'r', a: 'IfcSlab', b: 'IfcColumn', mode: 'hard', reportTouch: true };

async function runTs(elements: ClashElement[]): Promise<ClashResult> {
  return createClashEngine({ backend: 'ts' }).run(elements, [RULE]);
}

describe('reported touching result under translation (#5639)', () => {
  it('a 1 mm Z-overlap is a real clash, not "touching", at every placement orthogonal to it', async () => {
    for (const t of TRANSLATIONS) {
      const { clashes } = await runTs(slabAndColumn(0.001, t));
      expect(clashes, `translated by ${t}`).toHaveLength(1);
      const c = clashes[0]!;
      expect(c.status, `translated by ${t}`).toBe('hard');
      expect(c.depthFloor, `translated by ${t}: the engine records the floor`).toBeDefined();
      expect(c.depthFloor!, `translated by ${t}: floor below the depth`).toBeLessThan(-c.distance);
      expect(isTouching(c), `translated by ${t}`).toBe(false);
    }
  });

  it('the fallback band for a clash WITHOUT depthFloor is still the old, origin-dependent one', async () => {
    // Stated, not hidden: a clash recorded before the field existed keeps the
    // coordinate-magnitude band. 10 km out in X that band (~2.4 mm) swallows
    // the 1 mm clash above — the defect this field removes for engine results.
    const far = (await runTs(slabAndColumn(0.001, [WORLD_FRAME_OFFSET_M, 0, 0]))).clashes[0]!;
    const near = (await runTs(slabAndColumn(0.001, [0, 0, 0]))).clashes[0]!;
    const legacy = ({ depthFloor: _drop, ...rest }: typeof far) => rest;
    expect(isTouching(legacy(near))).toBe(false);
    expect(isTouching(legacy(far))).toBe(true);
  });

  it('a flush contact is touching at every placement', async () => {
    for (const t of TRANSLATIONS) {
      const { clashes } = await runTs(slabAndColumn(0, t));
      expect(clashes.map((c) => isTouching(c)), `translated by ${t}`).toEqual([true]);
    }
  });

  it('a sub-TOUCHING_EPSILON hard depth stays touching at every placement', async () => {
    // 50 um: above the pair's own Z floor near the origin (so the engine
    // reports `hard`), below the fixed 1e-4 band — reported as touching, the
    // #1273 behaviour, and still so 10 km out in X.
    for (const t of TRANSLATIONS) {
      const { clashes } = await runTs(slabAndColumn(5e-5, t));
      expect(clashes, `translated by ${t}`).toHaveLength(1);
      expect(clashes[0]!.status, `translated by ${t}`).toBe('hard');
      expect(isTouching(clashes[0]!), `translated by ${t}`).toBe(true);
    }
  });
});
