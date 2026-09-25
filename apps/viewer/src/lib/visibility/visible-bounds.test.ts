/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5884: Fit All frames what is visible. Two boxes 1 km apart; hiding,
 * isolating or hiding the model of one of them must shrink the framed box to
 * the other. With nothing filtered it stays the outlier-trimmed whole-scene
 * box (#1394).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture.js';
import type { FederatedModel } from '@/store';
import type { BoundingBox3D } from '@/utils/viewportUtils';
import { modelHiddenEntities } from './model-hidden-entities.js';
import { fitAllBounds, instancedPassDrawn, type FitAllInput } from './visible-bounds.js';

const box = (x: number): BoundingBox3D => ({ min: { x, y: 0, z: 0 }, max: { x: x + 1, y: 1, z: 1 } });
const span = (x0: number, x1: number): BoundingBox3D => ({ min: { x: x0, y: 0, z: 0 }, max: { x: x1, y: 1, z: 1 } });
// Flat 1 and 2, instanced 3, and 4: a sparse stray element 50 km out.
const BOXES = new Map<number, BoundingBox3D>([[1, box(0)], [2, box(1000)], [3, box(1500)], [4, box(50_000)]]);
/** The load-time outlier-trimmed box (#1394): excludes the stray element 4. */
const WHOLE: BoundingBox3D = { min: { x: -1, y: -1, z: -1 }, max: { x: 1600, y: 2, z: 2 } };
const NONE = new Set<number>();

function fit(over: Partial<FitAllInput>): BoundingBox3D {
  return fitAllBounds({
    meshIds: [1, 2, 4],
    instancedIds: [3],
    instancedDrawn: true,
    boundsOf: (id) => BOXES.get(id) ?? null,
    visibility: { hidden: NONE, isolated: null },
    wholeScene: WHOLE,
    ...over,
  });
}

describe('fitAllBounds (#5884)', () => {
  it('nothing filtered: the stray element stays trimmed away (#1394)', () => {
    // Clamped to the trimmed box's edge, which is what #1394 frames.
    assert.deepEqual(fit({}), span(0, 1600));
  });

  it('leaves hidden elements out (flat and instanced), trimming still applied', () => {
    assert.deepEqual(fit({ visibility: { hidden: new Set([2, 3, 4]), isolated: null } }), box(0));
    assert.deepEqual(
      fit({ visibility: { hidden: new Set([2]), isolated: null } }),
      span(0, 1600),
      'hiding one element does not bring the stray tail back',
    );
  });

  it('frames only the isolation (storey / class filter / isolate)', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set([2]) } }), box(1000));
  });

  it('isolating the trimmed-away element itself frames it', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set([4]) } }), box(50_000));
  });

  it('with N=2 models, a hidden far-away model B is not framed', () => {
    // As in the viewer: the flat list no longer carries B's meshes, but the
    // load-time box still spans B (it is not recomputed on a model hide).
    const a = fixtureModel('a', { idOffset: 0 });
    const b = { ...fixtureModel('b', { idOffset: 1000 }), visible: false };
    // Model B's instanced occurrence (global 1003) is still in the scene.
    b.geometryResult = { instancedGeometryAabbs: new Map([[1003, {}]]) } as unknown as FederatedModel['geometryResult'];
    const hidden = modelHiddenEntities(new Map([['a', a], ['b', b]]), new Set(), (m, id) => (m === 'b' ? id + 1000 : id));
    const placed = new Map<number, BoundingBox3D>([[1, box(0)], [1003, box(9000)]]);
    const bounds = fit({
      meshIds: [1],
      instancedIds: [1003],
      boundsOf: (id) => placed.get(id) ?? null,
      visibility: { hidden, isolated: null },
      wholeScene: span(0, 9001),
    });
    assert.deepEqual(bounds, box(0));
  });

  it('a hidden model with flat meshes only is not framed either (dropped from the list)', () => {
    // Every remaining id is visible, yet the load-time box still spans B.
    const bounds = fit({ meshIds: [1], instancedIds: [], wholeScene: span(0, 9001) });
    assert.deepEqual(bounds, box(0));
  });

  it('Types view: the undrawn instanced occurrences are not framed', () => {
    assert.deepEqual(fit({ instancedDrawn: false, meshIds: [1, 2] }), span(0, 1001));
  });

  it('falls back to the whole scene when nothing visible has bounds', () => {
    assert.deepEqual(fit({ visibility: { hidden: new Set([1, 2, 3, 4]), isolated: null } }), WHOLE);
  });

  it('falls back to the whole scene on a degenerate visible box', () => {
    const bad = new Map<number, BoundingBox3D>([[1, box(0)], [2, box(Number.NaN)]]);
    assert.deepEqual(fit({ meshIds: [1, 2], instancedIds: [], boundsOf: (id) => bad.get(id) ?? null }), WHOLE);
  });

  it('the instanced pass is hidden only in the Types view of a model with a type library', () => {
    assert.equal(instancedPassDrawn({ hasTypeGeometry: true, typeViewMode: 'types' }), false);
    assert.equal(instancedPassDrawn({ hasTypeGeometry: true, typeViewMode: 'model' }), true);
    assert.equal(instancedPassDrawn({ hasTypeGeometry: false, typeViewMode: 'types' }), true);
  });
});
