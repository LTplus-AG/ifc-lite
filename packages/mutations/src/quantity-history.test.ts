/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, expectTypeOf, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { MutablePropertyView } from './mutable-property-view.js';
import { replayQuantityMutation } from './quantity-replay.js';
import type { Mutation, QuantityMutation } from './types.js';

// The invariant is a source-backed length quantity with an explicit unit.
// Replay must distinguish omitted metadata from an intentional unit removal.
function sourceView() {
  const view = new MutablePropertyView(null, 'model');
  view.setQuantityExtractor(() => [{ name: 'Qto_Source', quantities: [
    { name: 'Length', type: QuantityType.Length, value: 12, unit: 'METRE' },
  ] }]);
  return view;
}

it('#6232 omitted setter unit retains source inheritance while null explicitly clears it', () => {
  const view = sourceView();
  const valueOnly = view.setQuantity(7, 'Qto_Source', 'Length', 13, QuantityType.Length);
  expect(view.getQuantitiesForEntity(7)[0].quantities[0]).toMatchObject({ value: 13, unit: 'METRE' });
  expect(valueOnly.unitRemoved).toBe(false);
  const edit = view.setQuantity(7, 'Qto_Source', 'Length', 14, QuantityType.Volume, null);
  expect(edit.oldQuantityType).toBe(QuantityType.Length);
  expect(edit.oldUnit).toBe('METRE');
  expect(view.getQuantitiesForEntity(7)[0].quantities[0].unit).toBeUndefined();
  const later = view.setQuantity(7, 'Qto_Source', 'Length', 15, QuantityType.Volume);
  expect(later.unitRemoved).toBe(true);
  expect(view.getQuantitiesForEntity(7)[0].quantities[0].unit).toBeUndefined();
  expectTypeOf<QuantityMutation['unit']>().toEqualTypeOf<string | undefined>();
});

it('#6232 serialized journal replay preserves explicit unit clearing and typed Undo/Redo', () => {
  const source = sourceView();
  const mutation = source.setQuantity(7, 'Qto_Source', 'Length', 7, QuantityType.Volume, null);
  const journal: Mutation[] = JSON.parse(JSON.stringify([mutation]));
  const target = sourceView();
  target.applyMutations(journal);
  const read = () => target.getQuantitiesForEntity(7)[0].quantities[0];
  expect(read()).toEqual({ name: 'Length', type: QuantityType.Volume, value: 7, unit: undefined });
  replayQuantityMutation(target, journal[0], 'undo', true);
  expect(read()).toEqual({ name: 'Length', type: QuantityType.Length, value: 12, unit: 'METRE' });
  replayQuantityMutation(target, journal[0], 'redo', true);
  expect(read()).toEqual({ name: 'Length', type: QuantityType.Volume, value: 7, unit: undefined });
});


it('#6232 omitted setter unit preserves an authored quantity unit', () => {
  const view = new MutablePropertyView(null, 'model');
  view.createQuantitySet(7, 'Qto_Authored', [{ name: 'Area', value: 12, quantityType: QuantityType.Area, unit: 'm2' }]);
  const edit = view.setQuantity(7, 'Qto_Authored', 'Area', 14, QuantityType.Area);
  expect(view.getQuantitiesForEntity(7)[0].quantities[0]).toEqual({ name: 'Area', value: 14, type: QuantityType.Area, unit: 'm2' });
  expect(edit.unit).toBe('m2');
  expect(edit.unitRemoved).toBe(false);
});

it('#6232 forward replay remains compatible with a write-only quantity target', () => {
  const source = sourceView(), target = sourceView();
  const mutation = source.setQuantity(7, 'Qto_Source', 'Length', 7, QuantityType.Volume, null);
  const writeOnly = { setQuantity: target.setQuantity.bind(target) };
  replayQuantityMutation(writeOnly, mutation);
  expect(target.getQuantitiesForEntity(7)[0].quantities[0]).toEqual({ name: 'Length', type: QuantityType.Volume, value: 7, unit: undefined });
  delete mutation.quantityType;
  replayQuantityMutation(writeOnly, mutation);
  expect(target.getQuantitiesForEntity(7)[0].quantities[0].type).toBe(QuantityType.Count);
});
