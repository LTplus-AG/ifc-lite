/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Section bar's distance arithmetic (#5499): metres shown on the bar are
 * the store's 0..100 `position` resolved against the same merged bounds the
 * renderer cuts against, and the storey list is the floor plan's.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectStoreys,
  mergedSectionBounds,
  percentToWorld,
  sectionAxisRange,
  storeyCutElevation,
  worldToPercent,
} from './section-distance.js';

const box = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
});
type BoundedModels = Parameters<typeof mergedSectionBounds>[0];
type Legacy = Parameters<typeof mergedSectionBounds>[1];
const model = (visible: boolean, bounds: ReturnType<typeof box> | undefined) => ({
  visible,
  geometryResult: bounds ? { coordinateInfo: { shiftedBounds: bounds } } : null,
});

describe('mergedSectionBounds', () => {
  it('unions every VISIBLE model box and ignores hidden and placeholder ones', () => {
    const models = new Map([
      ['a', model(true, box([0, -1, 0], [10, 3, 8]))],
      ['hidden', model(false, box([-50, -50, -50], [50, 50, 50]))],
      ['b', model(true, box([4, 0, -2], [12, 9, 1]))],
      ['empty', model(true, box([0, 0, 0], [0, 0, 0]))],
    ]) as unknown as BoundedModels;
    assert.deepEqual(mergedSectionBounds(models, null), box([0, -1, -2], [12, 9, 8]));
  });

  it('falls back to the legacy single-model result when no federated model is loaded', () => {
    const legacy = { coordinateInfo: { shiftedBounds: box([1, 2, 3], [4, 5, 6]) } } as unknown as Legacy;
    assert.deepEqual(mergedSectionBounds(new Map(), legacy), box([1, 2, 3], [4, 5, 6]));
    assert.equal(mergedSectionBounds(new Map(), null), null);
  });
});

describe('percent <-> world along an axis', () => {
  const bounds = box([0, -1, 0], [10, 3, 8]);
  it('resolves each cut axis to its viewer axis (down = Y, front = Z, side = X)', () => {
    assert.deepEqual(sectionAxisRange(bounds, 'down'), { min: -1, max: 3 });
    assert.deepEqual(sectionAxisRange(bounds, 'front'), { min: 0, max: 8 });
    assert.deepEqual(sectionAxisRange(bounds, 'side'), { min: 0, max: 10 });
    assert.equal(sectionAxisRange(null, 'down'), null);
    assert.equal(sectionAxisRange(box([0, 2, 0], [1, 2, 1]), 'down'), null, 'a flat axis has no range');
  });

  it('round-trips a position through metres and clamps out-of-range metres', () => {
    const range = sectionAxisRange(bounds, 'down')!;
    assert.equal(percentToWorld(50, range), 1);
    assert.equal(percentToWorld(0, range), -1);
    assert.equal(worldToPercent(1, range), 50);
    assert.equal(worldToPercent(1.2, range), 55.00000000000001);
    assert.equal(worldToPercent(99, range), 100);
    assert.equal(worldToPercent(-99, range), 0);
  });
});

describe('collectStoreys', () => {
  const ds = (storeys: Array<[number, string, number]>) => ({
    spatialHierarchy: {
      byStorey: new Map(storeys.map(([id]) => [id, []])),
      storeyElevations: new Map(storeys.map(([id, , elev]) => [id, elev])),
    },
    entities: { getName: (id: number) => storeys.find(([sid]) => sid === id)?.[1] ?? null },
  });

  it('lists storeys top-down, deduplicating levels shared across federated models at 0.5 m', () => {
    const models = new Map([
      ['arch', { ifcDataStore: ds([[1, 'Ground floor', 0], [2, 'First floor', 2.8]]) }],
      ['mep', { ifcDataStore: ds([[7, 'GF', 0.1], [8, 'Roof', 5.6]]) }],
      ['scan', { ifcDataStore: null }],
    ]);
    const storeys = collectStoreys(models, null);
    assert.deepEqual(storeys.map((s) => [s.name, s.elevation, s.modelId]), [
      ['Roof', 5.6, 'mep'],
      ['First floor', 2.8, 'arch'],
      ['GF', 0.1, 'mep'], // the shorter name wins the 0 m tie
    ]);
  });

  it('reads the legacy store when no federated model is loaded, and names an unnamed storey by id', () => {
    const storeys = collectStoreys(new Map(), ds([[3, '', 0]]));
    assert.deepEqual(storeys.map((s) => [s.name, s.modelId]), [['Storey #3', 'legacy']]);
    assert.deepEqual(collectStoreys(new Map(), null), []);
  });

  it('a plan cut sits 1.2 m above the floor', () => {
    assert.equal(storeyCutElevation({ elevation: 2.8 }), 4);
  });
});
