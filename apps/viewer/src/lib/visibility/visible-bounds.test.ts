/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5884: Fit All frames what is visible. Two boxes 1 km apart; hiding,
 * isolating or hiding the model of one of them must shrink the framed bounds
 * to the other.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureModel } from '@/test/store-fixture.js';
import { modelHiddenEntities } from './model-hidden-entities.js';
import { visibleBounds } from './visible-bounds.js';
import type { BoundingBox3D } from '@/utils/viewportUtils';
import type { FederatedModel } from '@/store';

const box = (x: number): BoundingBox3D => ({ min: { x, y: 0, z: 0 }, max: { x: x + 1, y: 1, z: 1 } });
const BOXES = new Map<number, BoundingBox3D>([[1, box(0)], [2, box(1000)]]);
const boundsOf = (id: number) => BOXES.get(id) ?? null;
const NONE = new Set<number>();

describe('visibleBounds (#5884)', () => {
  it('unions every box when nothing is hidden or isolated', () => {
    assert.deepEqual(visibleBounds(BOXES.keys(), boundsOf, { hidden: NONE, isolated: null }), {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1001, y: 1, z: 1 },
    });
  });

  it('leaves a hidden box out', () => {
    assert.deepEqual(visibleBounds(BOXES.keys(), boundsOf, { hidden: new Set([2]), isolated: null }), box(0));
  });

  it('frames only the isolation', () => {
    assert.deepEqual(visibleBounds(BOXES.keys(), boundsOf, { hidden: NONE, isolated: new Set([2]) }), box(1000));
  });

  it('with N=2 models, a hidden model B is left out', () => {
    // Model B (offset 1000) owns global id 1002, placed far away.
    const a = fixtureModel('a', { idOffset: 0 });
    const b = { ...fixtureModel('b', { idOffset: 1000 }), visible: false };
    // Model B's one mesh (global id 1002); only the ids matter here.
    b.geometryResult = { meshes: [{ expressId: 1002 }] } as unknown as FederatedModel['geometryResult'];
    const models = new Map([['a', a], ['b', b]]);
    const hidden = modelHiddenEntities(models, new Set(), (modelId, id) => (modelId === 'b' ? id + 1000 : id));
    const placed = new Map<number, BoundingBox3D>([[1, box(0)], [1002, box(5000)]]);
    const bounds = visibleBounds(placed.keys(), (id) => placed.get(id) ?? null, { hidden, isolated: null });
    assert.deepEqual(bounds, box(0));
  });

  it('returns null when nothing visible has bounds, so Fit All falls back to the whole scene', () => {
    assert.equal(visibleBounds(BOXES.keys(), boundsOf, { hidden: new Set([1, 2]), isolated: null }), null);
  });
});
