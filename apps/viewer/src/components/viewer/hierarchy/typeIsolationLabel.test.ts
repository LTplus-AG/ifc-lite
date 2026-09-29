/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { computeTypeIsolationLabel, type TypeIsolationModelMapLike } from './typeIsolationLabel.js';

/** A minimal `IfcDataStore` stub — only `entities.getTypeName` is read. */
function storeWithTypes(typesByExpressId: Record<number, string>): IfcDataStore {
  return {
    entities: {
      getTypeName: (expressId: number) => typesByExpressId[expressId] ?? '',
    },
  } as unknown as IfcDataStore;
}

describe('computeTypeIsolationLabel', () => {
  it('returns null when nothing is isolated', () => {
    assert.equal(computeTypeIsolationLabel(null, new Map(), null), null);
    assert.equal(computeTypeIsolationLabel(new Set(), new Map(), null), null);
  });

  it('single-model mode: labels with the shared type when every id is the same class', () => {
    // The real parsed table answers 'Unknown' for an id it does not hold.
    const types: Record<number, string> = { 1: 'IfcWall', 2: 'IfcWall' };
    const store = { entities: { getTypeName: (id: number) => types[id] ?? 'Unknown' } } as unknown as IfcDataStore;
    const models: TypeIsolationModelMapLike = new Map([
      ['m', { idOffset: 0, maxExpressId: 1000, ifcDataStore: store }],
    ]);
    assert.equal(computeTypeIsolationLabel(new Set([1, 2]), models, null), 'IfcWall');
  });

  it('single-model mode: falls back to a bare count for a mixed-class isolation', () => {
    const store = storeWithTypes({ 1: 'IfcWall', 2: 'IfcDoor' });
    const models: TypeIsolationModelMapLike = new Map([
      ['m', { idOffset: 0, maxExpressId: 1000, ifcDataStore: store }],
    ]);
    assert.equal(computeTypeIsolationLabel(new Set([1, 2]), models, null), '2 elements');
  });

  it('multi-model: resolves each id through its own model, offsets included', () => {
    const storeA = storeWithTypes({ 5: 'IfcWall' });
    const storeB = storeWithTypes({ 5: 'IfcWall' });
    const models: TypeIsolationModelMapLike = new Map([
      ['a', { idOffset: 0, maxExpressId: 1000, ifcDataStore: storeA }],
      ['b', { idOffset: 1_000_000, maxExpressId: 1000, ifcDataStore: storeB }],
    ]);
    // 5 -> model a, expressId 5. 1_000_005 -> model b, expressId 5.
    assert.equal(computeTypeIsolationLabel(new Set([5, 1_000_005]), models, null), 'IfcWall');
  });

  /**
   * RED without the fix: the old inline logic queried `fallbackStore` with
   * the RAW (un-offset) id whenever `fromGlobalIdFromModels` returned
   * `undefined` — reachable only in multi-model mode, when an id falls
   * outside every model's offset range. Here `999` (model a's own offset
   * range is [0, 1000], model b's is [1_000_000, 1_001_000]) resolves to
   * NEITHER, so the old code fed `999` straight into `fallbackStore` as an
   * expressId — and `fallbackStore` (below) happens to define a totally
   * unrelated `IfcDoor` at expressId 999, so the old code would report
   * 'IfcDoor' or, worse, silently "homogenize" a wall-only isolation. The
   * fix skips ids that don't resolve to any model instead.
   */
  it('multi-model: skips an id that resolves to no model rather than querying the fallback store with it raw', () => {
    const storeA = storeWithTypes({ 1: 'IfcWall' });
    const storeB = storeWithTypes({ 1: 'IfcWall' });
    // A coincidental, unrelated entity at raw expressId 5000 in whatever
    // store happens to be the "active" one — the trap the raw-id fallback
    // could fall into. 5000 sits strictly BETWEEN model a's range ([0, 1000])
    // and model b's ([1_000_000, 1_001_000]), so it resolves to neither.
    const fallbackStore = storeWithTypes({ 5000: 'IfcDoor' });
    const models: TypeIsolationModelMapLike = new Map([
      ['a', { idOffset: 0, maxExpressId: 1000, ifcDataStore: storeA }],
      ['b', { idOffset: 1_000_000, maxExpressId: 1000, ifcDataStore: storeB }],
    ]);
    // 1 -> model a (IfcWall). 1_000_001 -> model b (IfcWall). 5000 -> no
    // model -> must be skipped, not looked up in fallbackStore.
    const label = computeTypeIsolationLabel(new Set([1, 1_000_001, 5000]), models, fallbackStore);
    assert.equal(label, 'IfcWall', `an unresolved id must not pull in fallbackStore's IfcDoor; got ${label}`);
  });

  // #6233: an element authored this session is not in the parsed table, which
  // answers 'Unknown' for it; the chip reads the class through the overlay.
  it('labels an isolated authored wall by its authored class, and a retype by its new class', () => {
    // The real parsed table answers 'Unknown' for an id it does not hold.
    const types: Record<number, string> = { 1: 'IfcWall', 2: 'IfcWall' };
    const store = { entities: { getTypeName: (id: number) => types[id] ?? 'Unknown' } } as unknown as IfcDataStore;
    const models: TypeIsolationModelMapLike = new Map([
      ['m', { idOffset: 0, maxExpressId: 1000, ifcDataStore: store }],
    ]);
    const view = new MutablePropertyView(null, 'm');
    view.setExpressIdWatermark(100);
    const authored = view.createEntity('IfcWall', ['0Authored0000000000001', null, 'W']).expressId;
    const overlay = (modelId: string) => (modelId === 'm' ? view : undefined);
    assert.equal(computeTypeIsolationLabel(new Set([1, authored]), models, null, overlay), 'IfcWall');
    view.setEntityType(2, 'IfcColumn', null, 'IfcWall');
    assert.equal(computeTypeIsolationLabel(new Set([2]), models, null, overlay), 'IfcColumn');
  });
});
