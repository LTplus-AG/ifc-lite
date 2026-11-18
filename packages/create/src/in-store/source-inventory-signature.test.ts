// SPDX-License-Identifier: MPL-2.0
import { expect, it } from 'vitest';
import { hostOpeningCandidates } from './host-opening-candidates.js';
import { orderedWallJoinCandidates } from './wall-join-order.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { readStoreyInventory } from './storey/storey-model.js';
import { newStorey } from './wall-join-mesh.oracle.js';

it('#10420 source inventories tolerate a missing columnar entities table', async () => {
  const { store: original, view, storeyId } = await newStorey();
  const store = { ...original };
  Reflect.deleteProperty(store, 'entities');
  const reader = new AnchorEntityReader(store, view);
  expect.soft(() => [...hostOpeningCandidates(store, storeyId, view)]).not.toThrow();
  expect.soft(() => [...orderedWallJoinCandidates(store, view, new Set([storeyId]), reader)]).not.toThrow();
  expect(readStoreyInventory(store, view).storeys.map(row => row.expressId)).toContain(storeyId);
});
