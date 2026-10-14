/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSectionPlaneFrame } from './render-section-plane.js';
import type { BatchedMesh, RenderOptions, SectionPlane } from './types.js';

/**
 * Cutting planes beyond the first (#7545) are resolved by the same code as the
 * primary plane, so a second cardinal plane means exactly what it would mean as
 * the first: the slider range, the building rotation and the explicit-normal
 * guards are shared, not re-implemented.
 */

const BOUNDS = { min: [-20, 0, -10] as [number, number, number], max: [20, 10, 10] as [number, number, number] };

function resolve(options: RenderOptions) {
  return resolveSectionPlaneFrame({
    options,
    batchedMeshes: [{ bounds: BOUNDS } as unknown as BatchedMesh],
    meshes: [],
    pointCloudBounds: null,
    logSectionBounds: false,
    spendLogLatch: () => {},
  });
}

const plane = (patch: Partial<SectionPlane>): SectionPlane => ({ axis: 'down', position: 50, enabled: true, ...patch });

describe('extra section planes resolve like the primary plane (#7545)', () => {
  it('gives an extra cardinal plane the same normal and distance it would have as the primary', () => {
    const asPrimary = resolve({ sectionPlane: plane({ axis: 'side', position: 25 }) }).sectionPlaneData!;
    const asExtra = resolve({
      sectionPlane: plane({ axis: 'down', position: 50 }),
      extraSectionPlanes: [plane({ axis: 'side', position: 25 })],
    }).extraPlanes[0]!;
    assert.deepEqual(asExtra.normal, asPrimary.normal);
    assert.equal(asExtra.distance, asPrimary.distance);
    assert.equal(asExtra.distance, -10, '25% of the -20..20 X extent');
  });

  it('applies the building rotation to extra planes too', () => {
    const rotation = Math.PI / 6;
    const frame = resolve({
      buildingRotation: rotation,
      sectionPlane: plane({ axis: 'down' }),
      extraSectionPlanes: [plane({ axis: 'side', position: 50 })],
    });
    const [nx, , nz] = frame.extraPlanes[0]!.normal;
    assert.ok(Math.abs(nx - Math.cos(rotation)) < 1e-9);
    assert.ok(Math.abs(nz - Math.sin(rotation)) < 1e-9);
  });

  it('uses an explicit normal and distance verbatim and carries `flipped`', () => {
    const frame = resolve({
      sectionPlane: plane({}),
      extraSectionPlanes: [plane({ axis: 'side', normal: [0, 0, 1], distance: 3, flipped: true })],
    });
    assert.deepEqual(frame.extraPlanes, [{ normal: [0, 0, 1], distance: 3, flipped: true }]);
  });

  it('skips disabled planes and caps the list at seven', () => {
    const many = Array.from({ length: 11 }, (_, i) => plane({ position: i * 10, enabled: i !== 2 }));
    const frame = resolve({ sectionPlane: plane({}), extraSectionPlanes: many });
    assert.equal(frame.extraPlanes.length, 7);
    assert.equal(frame.extraPlanes.some((p) => p.distance === 2), false, 'plane 2 is disabled and never clips');
  });

  it('resolves extra planes even when the primary plane is absent, and reports the bounds', () => {
    const frame = resolve({ extraSectionPlanes: [plane({ axis: 'down', position: 100 })] });
    assert.equal(frame.sectionPlaneData, undefined);
    assert.equal(frame.extraPlanes[0]!.distance, 10);
    assert.deepEqual(frame.bounds?.max, { x: 20, y: 10, z: 10 });
  });

  it('is a no-op for a single plane: no extras, the primary plane unchanged', () => {
    const frame = resolve({ sectionPlane: plane({ axis: 'down', position: 30 }) });
    assert.deepEqual(frame.extraPlanes, []);
    assert.equal(frame.sectionPlaneData!.distance, 3);
  });

  it('never lets a non-finite explicit extra plane reach the shader (#2442)', () => {
    const frame = resolve({
      sectionPlane: plane({}),
      extraSectionPlanes: [plane({ axis: 'side', normal: [Infinity, 0, 0], distance: 5 })],
    });
    const p = frame.extraPlanes[0]!;
    assert.ok(p.normal.every(Number.isFinite) && Number.isFinite(p.distance));
  });
});
