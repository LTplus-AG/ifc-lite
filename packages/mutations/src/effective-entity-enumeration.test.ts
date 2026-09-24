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

  it('restricts source rows to a caller table while retaining creations and retypes', () => {
    const store = source();
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    view.setEntityType(1, 'IfcDoor', null, 'IfcWall');
    const created = view.createEntity('IfcWall', []);

    expect(ids(iterateEffectiveEntityIds(store, view, undefined, [0, 1, 2])))
      .toEqual([1, 2, created.expressId]);
    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCDOOR'], [0, 1, 2])))
      .toEqual([1]);
    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCWALL'], [0, 1, 2])))
      .toEqual([2, created.expressId]);
  });

  it('finds a retyped source record held in the deferred ID index (#5249)', () => {
    const store: EntityEnumerationSource = {
      entityIndex: {
        byType: new Map([['IFCPROPERTYSINGLEVALUE', [9]]]),
        byId: new Map(),
      },
      deferredEntityIndex: new Map([[9, { type: 'IFCPROPERTYSINGLEVALUE' }]]),
    };
    const view = new MutablePropertyView(null, 'm');
    view.setEntityType(9, 'IfcPropertyListValue', null, 'IfcPropertySingleValue');

    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCPROPERTYLISTVALUE']))).toEqual([9]);
    expect(ids(iterateEffectiveEntityIds(store, view, ['IFCPROPERTYSINGLEVALUE']))).toEqual([]);
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

describe('single-class enumeration reads the created-entity class index (#5413)', () => {
  /** The view, with the full created list made unreadable: the indexed path must not need it. */
  function indexedOnly(view: MutablePropertyView): MutablePropertyView {
    return new Proxy(view, {
      get(target, key, receiver) {
        if (key === 'getNewEntities') return () => { throw new Error('scanned every created entity'); };
        const value: unknown = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  it('answers one class from its bucket, in creation order, without the full created list', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    const a = view.createEntity('IfcColumn', []);
    view.createEntity('IfcCartesianPoint', []);
    const b = view.createEntity('IFCCOLUMN', []);
    for (let i = 0; i < 50; i++) view.createEntity('IfcLocalPlacement', []);

    expect(ids(iterateEffectiveEntityIds(source(), indexedOnly(view), ['IfcColumn']))).toEqual([a.expressId, b.expressId]);
    expect(ids(iterateEffectiveEntityIds(source(), indexedOnly(view), ['IFCWALL']))).toEqual([1, 2]);
  });

  it('keeps the bucket in step with delete, restore and clear', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    const a = view.createEntity('IfcColumn', []);
    const b = view.createEntity('IfcColumn', []);
    const column = () => ids(iterateEffectiveEntityIds(source(), indexedOnly(view), ['IFCCOLUMN']));

    view.deleteEntity(a.expressId);
    expect(column()).toEqual([b.expressId]);
    view.restoreNewEntity(a);
    expect(column()).toEqual([b.expressId, a.expressId]);
    expect(ids(iterateEffectiveEntityIds(source(), view, ['IFCCOLUMN']))).toEqual(column());
    view.clear();
    expect(column()).toEqual([]);
  });

  it('does not see, or loop over, entities created while the caller iterates', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    const first = view.createEntity('IfcColumn', []);
    const seen: number[] = [];
    for (const { expressId } of iterateEffectiveEntityIds(source(), view, ['IFCCOLUMN'])) {
      seen.push(expressId);
      view.createEntity('IfcColumn', []);
    }
    expect(seen).toEqual([first.expressId]);
  });

  it('falls back to the full list when a created entity is retyped, so its effective class still wins', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    const moved = view.createEntity('IfcColumn', []);
    const kept = view.createEntity('IfcColumn', []);
    view.setEntityType(moved.expressId, 'IfcBeam');

    expect(ids(iterateEffectiveEntityIds(source(), view, ['IFCCOLUMN']))).toEqual([kept.expressId]);
    expect(ids(iterateEffectiveEntityIds(source(), view, ['IFCBEAM']))).toEqual([moved.expressId]);
  });

  it('survives atomic commit and rollback, whose snapshots clone the index away', () => {
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(3);
    const before = view.createEntity('IfcColumn', []);
    // A restore that dropped the index made this enumeration throw; report that
    // as a value so the assertion below names the failure.
    const column = (): number[] | 'enumeration threw' => {
      try {
        return ids(iterateEffectiveEntityIds(source(), indexedOnly(view), ['IFCCOLUMN']));
      } catch {
        return 'enumeration threw';
      }
    };

    const added = view.runAtomic((draft) => draft.createEntity('IfcColumn', []));
    expect(column()).toEqual([before.expressId, added.expressId]);

    const prepared = view.prepareAtomic((draft) => draft.createEntity('IfcColumn', []));
    prepared.commit();
    expect(column()).toEqual([before.expressId, added.expressId, prepared.result.expressId]);
    prepared.rollback();
    expect(column()).toEqual([before.expressId, added.expressId]);

    // Writes after a restore keep the index in step too.
    const later = view.createEntity('IfcColumn', []);
    view.deleteEntity(before.expressId);
    expect(column()).toEqual([added.expressId, later.expressId]);
  });
});
