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
import { fitAllBounds, type FitAllInput } from './visible-bounds.js';

const box = (x: number): BoundingBox3D => ({ min: { x, y: 0, z: 0 }, max: { x: x + 1, y: 1, z: 1 } });
const BOXES = new Map<number, BoundingBox3D>([[1, box(0)], [2, box(1000)], [3, box(1500)]]);
/** The trimmed load-time box: excludes nothing here, but is distinguishable. */
const WHOLE: BoundingBox3D = { min: { x: -1, y: -1, z: -1 }, max: { x: 2000, y: 2, z: 2 } };
const NONE = new Set<number>();

function fit(over: Partial<FitAllInput>): BoundingBox3D {
  return fitAllBounds({
    meshIds: [1, 2],
    instancedIds: [3],
    instancedDrawn: true,
    boundsOf: (id) => BOXES.get(id) ?? null,
    visibility: { hidden: NONE, isolated: null },
    wholeScene: WHOLE,
    ...over,
  });
}

describe('fitAllBounds (#5884)', () => {
  it('nothing filtered: the outlier-trimmed whole-scene box, not a raw union (#1394)', () => {
    assert.deepEqual(fit({}), WHOLE);
  });

  it('leaves a hidden element out (flat and instanced)', () => {
    assert.deepEqual(fit({ visibility: { hidden: new Set([2, 3]), isolated: null } }), box(0));
  });

  it('frames only the isolation (storey / class filter / isolate)', () => {
    assert.deepEqual(fit({ visibility: { hidden: NONE, isolated: new Set([2]) } }), box(1000));
  });

  it('with N=2 models, a hidden model B is left out, its instanced occurrences too', () => {
    const a = fixtureModel('a', { idOffset: 0 });
    const b = { ...fixtureModel('b', { idOffset: 1000 }), visible: false };
    // Model B: one flat mesh (global 1002) and one instanced occurrence (1003).
    b.geometryResult = {
      meshes: [{ expressId: 1002 }],
      instancedGeometryAabbs: new Map([[1003, {}]]),
    } as unknown as FederatedModel['geometryResult'];
    const hidden = modelHiddenEntities(new Map([['a', a], ['b', b]]), new Set(), (m, id) => (m === 'b' ? id + 1000 : id));
    const placed = new Map<number, BoundingBox3D>([[1, box(0)], [1002, box(5000)], [1003, box(9000)]]);
    const bounds = fit({
      meshIds: [1, 1002],
      instancedIds: [1003],
      boundsOf: (id) => placed.get(id) ?? null,
      visibility: { hidden, isolated: null },
    });
    assert.deepEqual(bounds, box(0));
  });

  it('Types view: the undrawn instanced occurrences are not framed', () => {
    assert.deepEqual(fit({ instancedDrawn: false }), { min: { x: 0, y: 0, z: 0 }, max: { x: 1001, y: 1, z: 1 } });
  });

  it('falls back to the whole scene when nothing visible has bounds', () => {
    assert.deepEqual(fit({ visibility: { hidden: new Set([1, 2, 3]), isolated: null } }), WHOLE);
  });

  it('falls back to the whole scene on a degenerate visible box', () => {
    const bad = new Map<number, BoundingBox3D>([[1, box(0)], [2, box(Number.NaN)]]);
    assert.deepEqual(
      fit({ boundsOf: (id) => bad.get(id) ?? null, visibility: { hidden: new Set([3]), isolated: null } }),
      WHOLE,
    );
  });
});
