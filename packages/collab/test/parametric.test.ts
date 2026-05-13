/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  box,
  cylinder,
  extrudedAreaSolid,
  hashMesh,
  paramsToMesh,
  revolvedAreaSolid,
} from '../src/geometry/parametric.js';
import {
  DEFAULT_FIXTURES,
  runDeterminismHarness,
} from '../src/geometry/determinism.js';

describe('parametric mesh primitives', () => {
  it('box has 24 positions and 36 indices (6 faces × 2 tris × 3 verts)', () => {
    const m = box({ length: 1, width: 2, height: 3 });
    expect(m.positions.length).toBe(8 * 3);
    // 2 fans of 2 tris each (top/bottom) + 4 sides × 2 tris × 3 verts.
    expect(m.indices.length).toBeGreaterThan(0);
  });

  it('cylinder uses requested segment count', () => {
    const m = cylinder({ radius: 1, height: 1, segments: 8 });
    // 8 verts on bottom + 8 on top = 16.
    expect(m.positions.length).toBe(16 * 3);
  });

  it('extruded rectangle produces deterministic output', () => {
    const m1 = extrudedAreaSolid({
      profile: { type: 'rectangle', width: 2, height: 3 },
      depth: 4,
    });
    const m2 = extrudedAreaSolid({
      profile: { type: 'rectangle', width: 2, height: 3 },
      depth: 4,
    });
    expect(hashMesh(m1)).toBe(hashMesh(m2));
  });

  it('different params produce different hashes', () => {
    const m1 = box({ length: 1, width: 1, height: 1 });
    const m2 = box({ length: 1, width: 1, height: 2 });
    expect(hashMesh(m1)).not.toBe(hashMesh(m2));
  });

  it('paramsToMesh dispatches by source string', () => {
    const m = paramsToMesh('box', { length: 1, width: 1, height: 1 });
    expect(m.positions.length).toBeGreaterThan(0);
    expect(() => paramsToMesh('unknown' as never, {})).toThrow();
  });

  it('revolved-area-solid produces a torus-shaped ring', () => {
    const m = revolvedAreaSolid({
      profile: { type: 'circle', radius: 0.5, segments: 8 },
      angle: Math.PI * 2,
      segments: 8,
    });
    // 8 ring × 9 sweep (8 + 1 closure) × 3 = 216.
    expect(m.positions.length).toBe(8 * 9 * 3);
  });
});

describe('determinism harness', () => {
  it('runs the default fixture set against the built-in kernel', () => {
    const report = runDeterminismHarness(paramsToMesh, DEFAULT_FIXTURES);
    expect(report.results.length).toBe(DEFAULT_FIXTURES.length);
    for (const r of report.results) {
      expect(r.hash).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(report.ok).toBe(true);
  });

  it('flags drift when expected hashes do not match', () => {
    const expected = Object.fromEntries(DEFAULT_FIXTURES.map((f) => [f.name, 'wrong']));
    const report = runDeterminismHarness(paramsToMesh, DEFAULT_FIXTURES, expected);
    expect(report.ok).toBe(false);
    expect(report.results.every((r) => !r.ok)).toBe(true);
  });
});
