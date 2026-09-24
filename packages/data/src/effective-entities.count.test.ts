/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { countEffectiveEntityTypes, type EffectiveEntityOverlay, type EffectiveEntitySource } from './effective-entities.js';

const source: EffectiveEntitySource = {
  entityIndex: {
    byType: new Map([['IFCWALL', [1, 2]], ['IFCDOOR', [3]]]),
    byId: new Map([[1, { type: 'IFCWALL' }], [2, { type: 'IFCWALL' }], [3, { type: 'IFCDOOR' }]]),
  },
};

describe('effective type counts (#5249)', () => {
  it('moves a retyped source record, removes a tombstone and adds a creation', () => {
    const tombstones = new Set([3, 5]);
    const retypes = new Map([[1, { newType: 'IfcDoor' }], [4, { newType: 'IfcDoor' }]]);
    const overlay: EffectiveEntityOverlay = {
      isDeleted: id => tombstones.has(id),
      getTombstones: () => tombstones,
      getTypeMutations: () => retypes,
      getNewEntities: () => [{ expressId: 4, type: 'IfcWall' }],
    };
    expect([...countEffectiveEntityTypes(source, overlay)])
      .toEqual([['IFCWALL', 1], ['IFCDOOR', 2]]);
  });

  it('counts an indexless columnar source with the caller supplied source domain', () => {
    const indexless: EffectiveEntitySource = {
      entityIndex: { byType: new Map(), byId: new Map() },
      entities: { getTypeName: id => id === 1 ? 'IfcWall' : 'IfcDoor' },
    };
    const overlay: EffectiveEntityOverlay = {
      isDeleted: id => id === 2,
      getNewEntities: () => [{ expressId: 3, type: 'IfcDoor' }],
    };
    expect([...countEffectiveEntityTypes(indexless, overlay, [1, 2])])
      .toEqual([['IFCWALL', 1], ['IFCDOOR', 1]]);
  });

  it('falls back to the canonical walk for overlays without indexed tombstones', () => {
    const overlay: EffectiveEntityOverlay = {
      isDeleted: id => id === 2,
      getNewEntities: () => [{ expressId: 4, type: 'IfcBeam' }],
    };
    expect([...countEffectiveEntityTypes(source, overlay)])
      .toEqual([['IFCWALL', 1], ['IFCDOOR', 1], ['IFCBEAM', 1]]);
  });
});
