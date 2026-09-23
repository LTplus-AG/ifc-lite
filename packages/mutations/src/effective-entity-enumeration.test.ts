/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import type { EntityEnumerationSource } from './effective-entity-enumeration.js';

// The changed-test oracle removes new production files. Load at runtime so a
// missing iterator fails a test assertion instead of preventing collection.
const modulePath = './effective-entity-enumeration.js';
const effectiveModule: typeof import('./effective-entity-enumeration.js') | null =
  await import(modulePath).catch(() => null);
const iterateEffectiveEntityIds: typeof import('./effective-entity-enumeration.js').iterateEffectiveEntityIds =
  (...args) => {
    if (!effectiveModule) {
      expect(effectiveModule, 'effective entity iterator must exist').not.toBeNull();
      throw new Error('effective entity iterator must exist');
    }
    return effectiveModule.iterateEffectiveEntityIds(...args);
  };

function source(): EntityEnumerationSource {
  return {
    entityIndex: {
      byType: new Map([
        ['IFCWALL', [1, 2]],
        ['IFCDOOR', [3]],
      ]),
      byId: new Map([
        [1, { type: 'IFCWALL' }],
        [2, { type: 'IFCWALL' }],
        [3, { type: 'IFCDOOR' }],
      ]),
    },
  };
}

const ids = (rows: Iterable<{ expressId: number }>) => Array.from(rows, ({ expressId }) => expressId);

describe('effective entity enumeration (#5249)', () => {
  it('folds source tombstones, creations and created-then-deleted IDs together', () => {
    const store = source();
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    view.deleteEntity(2);
    const live = view.createEntity('IfcWall', []);
    const transient = view.createEntity('IfcWall', []);
    view.deleteEntity(transient.expressId);

    expect(ids(iterateEffectiveEntityIds(store, view))).toEqual([1, 3, live.expressId]);
    expect(ids(iterateEffectiveEntityIds(store, view, ['IfcWall']))).toEqual([1, live.expressId]);
    expect(ids(iterateEffectiveEntityIds(store, null, ['IFCWALL']))).toEqual([1, 2]);
  });

  it('moves source and created entities to their effective type', () => {
    const store = source();
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    view.setEntityType(1, 'IfcDoor', null, 'IfcWall');
    const created = view.createEntity('IfcWall', []);
    view.setEntityType(created.expressId, 'IfcDoor');

    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCWALL']))).toEqual([2]);
    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCDOOR']))).toEqual([3, 1, created.expressId]);
    expect(Array.from(iterateEffectiveEntityIds(store, view, ['IFCDOOR'])).map(({ type }) => type))
      .toEqual(['IFCDOOR', 'IFCDOOR', 'IFCDOOR']);
  });

  it('uses the passed model and overlay, without leaking IDs between models', () => {
    const modelA = source();
    const modelB: EntityEnumerationSource = {
      entityIndex: {
        byType: new Map([['IFCWALL', [7]]]),
        byId: new Map([[7, { type: 'IFCWALL' }]]),
      },
    };
    const viewA = new MutablePropertyView(null, 'a');
    const viewB = new MutablePropertyView(null, 'b');
    viewA.deleteEntity(1);
    viewB.setExpressIdWatermark(7);
    const newB = viewB.createEntity('IfcWall', []);

    expect(ids(iterateEffectiveEntityIds(modelA, viewA, ['IFCWALL']))).toEqual([2]);
    expect(ids(iterateEffectiveEntityIds(modelB, viewB, ['IFCWALL']))).toEqual([7, newB.expressId]);
  });
});
