/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL file was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { prepareMutationViewMerge } from './merge-overlay-state.js';
import { MutablePropertyView } from './mutable-property-view.js';

it('preserves distinct legacy edits, including edits to different fields on one source entity (#10676)', () => {
  const preferred = new MutablePropertyView(null, '__legacy__');
  const historical = new MutablePropertyView(null, 'default');
  preferred.setAttribute(10, 'Name', 'Canonical wall');
  historical.setAttribute(10, 'Name', 'Earlier wall');
  historical.setAttribute(10, 'Description', 'Historical description');
  historical.setAttribute(11, 'Name', 'Second wall', undefined, true);

  const merge = prepareMutationViewMerge(preferred, [historical]);
  const attributes = (view: MutablePropertyView, entity: number) =>
    Object.fromEntries(view.getAttributeMutationsForEntity(entity).map(row => [row.name, row.value]));
  expect(attributes(preferred, 10)).toEqual({ Name: 'Canonical wall' });
  merge.commit();
  expect(attributes(preferred, 10)).toEqual({ Name: 'Canonical wall', Description: 'Historical description' });
  expect(attributes(preferred, 11)).toEqual({ Name: 'Second wall' });
  expect(preferred.getMutations()).toHaveLength(3);
  expect(attributes(historical, 10)).toEqual({ Name: 'Earlier wall', Description: 'Historical description' });
});

it('reports a shared allocated EXPRESS ID without discarding either entity (#10676)', () => {
  const preferred = new MutablePropertyView(null, '__legacy__');
  const historical = new MutablePropertyView(null, 'default');
  preferred.setExpressIdWatermark(100);
  historical.setExpressIdWatermark(100);
  const first = preferred.createEntity('IfcWall', ['first']);
  const second = historical.createEntity('IfcWall', ['second']);
  expect(first.expressId).toEqual(second.expressId);
  expect(() => prepareMutationViewMerge(preferred, [historical])).toThrow(/Conflicting overlay edits on entity #101/);
  expect(preferred.getNewEntity(101)?.attributes[0]).toBe('first');
  expect(historical.getNewEntity(101)?.attributes[0]).toBe('second');
});

it('keeps separate property and quantity targets and protects whole-set edits (#10676)', () => {
  const preferred = new MutablePropertyView(null, '__legacy__');
  const historical = new MutablePropertyView(null, 'default');
  preferred.setProperty(10, 'Pset_WallCommon', 'Reference', 'A');
  historical.createQuantitySet(10, 'Qto_WallBaseQuantities', [{ name: 'GrossVolume', value: 8, quantityType: QuantityType.Volume }]);
  prepareMutationViewMerge(preferred, [historical]).commit();
  expect(preferred.getForEntity(10)[0]?.properties[0]?.value).toBe('A');
  expect(preferred.getQuantitiesForEntity(10)[0]?.quantities[0]?.value).toBe(8);

  preferred.setQuantity(10, 'Qto_WallBaseQuantities', 'GrossVolume', 6, QuantityType.Volume);
  expect(() => prepareMutationViewMerge(preferred, [historical])).toThrow(/Conflicting overlay edits on quantity set/);
  expect(historical.getQuantitiesForEntity(10)[0]?.quantities[0]?.value).toBe(8);
});

it.each(['preferred', 'historical'] as const)('refuses a changed %s input and publishes a fresh merge once (#10676)', changed => {
  const preferred = new MutablePropertyView(null, '__legacy__');
  const historical = new MutablePropertyView(null, 'default');
  historical.setAttribute(10, 'Name', 'Historical wall');

  const stale = prepareMutationViewMerge(preferred, [historical]);
  const changedView = changed === 'preferred' ? preferred : historical;
  changedView.setAttribute(11, 'Name', 'Later edit');

  expect(() => stale.commit()).toThrow(/changed during alias reconciliation/);
  expect(preferred.getAttributeMutationsForEntity(10)).toEqual([]);
  expect(changedView.getAttributeMutationsForEntity(11)[0]?.value).toBe('Later edit');

  const fresh = prepareMutationViewMerge(preferred, [historical]);
  fresh.commit();
  const revision = preferred.getMutationRevision();
  expect(preferred.getAttributeMutationsForEntity(10)[0]?.value).toBe('Historical wall');
  expect(preferred.getAttributeMutationsForEntity(11)[0]?.value).toBe('Later edit');
  fresh.commit();
  expect(preferred.getMutationRevision()).toBe(revision);
});
