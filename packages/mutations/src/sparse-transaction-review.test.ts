// SPDX-License-Identifier: MPL-2.0
/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { expect, it } from 'vitest';
import { MutablePropertyView } from './mutable-property-view.js';
import { StoreEditor } from './store-editor.js';

it('#9411 rejects a reentrant allocator seed instead of reusing source IDs', () => {
  const view = new MutablePropertyView(null, 'allocator');
  expect(() => view.runAtomic(() => view.setExpressIdWatermark(100))).toThrow('overlay changed');
  expect(view.createEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBe(101);
});

it('#9411 preserves a live StoreEditor watermark refresh when a source index grows', () => {
  const source = new Map([[10, { expressId: 10, type: 'IFCWALL', byteOffset: 0, byteLength: 1, lineNumber: 1 }]]);
  const view = new MutablePropertyView(null, 'source-growth');
  const editor = new StoreEditor({ entityIndex: { byId: source } }, view);
  expect(() => editor.runAtomic(draft => {
    draft.addEntity('IfcCartesianPoint', [[1, 2, 3]]);
    source.set(100, { expressId: 100, type: 'IFCWALL', byteOffset: 1, byteLength: 1, lineNumber: 2 });
    editor.refreshWatermark();
  })).toThrow('overlay changed');
  expect(view.getNewEntities()).toEqual([]);
  expect(view.createEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBe(101);
});

it('#9411 accepts draft allocator changes and unchanged live seeds', () => {
  const view = new MutablePropertyView(null, 'allocator-noop');
  view.setExpressIdWatermark(10);
  view.runAtomic(draft => {
    view.setExpressIdWatermark(10);
    view.setExpressIdWatermark(9);
    draft.setExpressIdWatermark(100);
  });
  expect(view.createEntity('IfcCartesianPoint', [[0, 0, 0]]).expressId).toBe(101);
});

for (const retainedBefore of [true, false]) {
  it(`#9411 preserves an original attribute-array edit during a draft (retainedBefore=${retainedBefore})`, () => {
    const view = new MutablePropertyView(null, 'retained');
    const editor = new StoreEditor({ entityIndex: { byId: new Map() } }, view);
    const point = editor.addEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
    const retained = retainedBefore ? editor.getNewEntity(point)!.attributes : undefined;
    const historyCount = view.getMutationCount(), next = view.peekNextExpressId();
    expect(() => editor.runAtomic(draft => {
      draft.getNewEntity(point); // Detach the old value before the original changes.
      draft.addEntity('IfcCartesianPoint', [[7, 8, 9]]);
      const attributes = retained ?? editor.getNewEntity(point)!.attributes;
      attributes[0] = [4, 5, 6];
    })).toThrow('overlay changed');
    expect(editor.getNewEntity(point)!.attributes).toEqual([[4, 5, 6]]);
    expect(view.getMutationCount()).toBe(historyCount);
    expect(view.peekNextExpressId()).toBe(next);
    // A failed guard must not leave its old snapshot installed on the view.
    editor.runAtomic(draft => draft.setPositionalAttribute(point, 0, [10, 11, 12]));
    expect(view.getPositionalMutationsForEntity(point)?.get(0)).toEqual([10, 11, 12]);
  });
}

it('#9411 detects retained-array conflicts in a nested sparse draft', () => {
  const view = new MutablePropertyView(null, 'nested');
  const point = view.createEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId;
  view.runAtomic(outer => {
    const retained = outer.getNewEntity(point)!.attributes;
    expect(() => outer.runAtomic(inner => {
      inner.getNewEntity(point);
      retained[0] = [4, 5, 6];
    })).toThrow('overlay changed');
    expect(outer.getNewEntity(point)!.attributes).toEqual([[4, 5, 6]]);
  });
  expect(view.getNewEntity(point)!.attributes).toEqual([[4, 5, 6]]);
});
