/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useHierarchyTree } from './useHierarchyTree';

afterEach(cleanup);

it('keeps the #5886 class builder invocation count at one through repeated expansion toggles', async () => {
  const model = fixtureModel('expansion-model', { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Wall A' },
    { expressId: 8, type: 'IfcWall', name: 'Wall B' },
  ] });
  const entities = model.ifcDataStore!.entities;
  const expressIds = entities.expressId;
  let scannedRows = 0;
  Object.defineProperty(entities, 'expressId', {
    configurable: true,
    get() { scannedRows++; return expressIds; },
  });
  const models = fixtureModels(model).models;
  useViewerStore.setState({ ...fixtureModels(model), hierarchyMode: 'type' });

  let tree!: ReturnType<typeof useHierarchyTree>;
  function Probe() {
    tree = useHierarchyTree({ models, ifcDataStore: null, isMultiModel: false });
    return null;
  }
  render(<Probe />);
  assert.equal(tree.treeData.length, 1, 'the class group starts collapsed');
  // NEW-4: the complete structure is built at idle, not in the first commit.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.ok(scannedRows > 0, 'the structural builder read real entity rows');
  const initialScans = scannedRows;

  for (let i = 0; i < 8; i++) {
    act(() => tree.toggleExpand('type-IfcWall'));
    assert.equal(tree.treeData.length, i % 2 === 0 ? 3 : 1, 'only the visible row projection changes');
  }
  assert.equal(scannedRows, initialScans, 'expansion must never invoke the class builder again');

  act(() => tree.setSearchQuery('Wall B'));
  assert.ok(tree.filteredNodes.some((node) => node.name === 'Wall B'), 'search sees the complete structure');
  assert.equal(scannedRows, initialScans, 'search must reuse the same structure');

  act(() => tree.setSearchQuery(''));
  let revealed: string | null = null;
  act(() => { revealed = tree.revealGlobalId(8); });
  assert.ok(revealed, 'an external selection resolves to the full-tree leaf');
  assert.equal(scannedRows, initialScans, 'reveal must reuse the same structure');
});

it('builds the complete structure once, on demand, when search runs before idle (NEW-4)', () => {
  const model = fixtureModel('search-first-model', { entities: [
    { expressId: 7, type: 'IfcWall', name: 'Wall A' },
    { expressId: 8, type: 'IfcWall', name: 'Wall B' },
  ] });
  const entities = model.ifcDataStore!.entities;
  const expressIds = entities.expressId;
  let scannedRows = 0;
  Object.defineProperty(entities, 'expressId', {
    configurable: true,
    get() { scannedRows++; return expressIds; },
  });
  const models = fixtureModels(model).models;
  useViewerStore.setState({ ...fixtureModels(model), hierarchyMode: 'type' });

  let tree!: ReturnType<typeof useHierarchyTree>;
  function Probe() {
    tree = useHierarchyTree({ models, ifcDataStore: null, isMultiModel: false });
    return null;
  }
  render(<Probe />);
  act(() => tree.setSearchQuery('Wall B'));
  assert.ok(tree.filteredNodes.some((node) => node.name === 'Wall B'), 'search sees the complete structure at once');
  const afterSearch = scannedRows;
  act(() => tree.setSearchQuery('Wall'));
  act(() => tree.setSearchQuery(''));
  let revealed: string | null = null;
  act(() => { revealed = tree.revealGlobalId(8); });
  assert.ok(revealed, 'reveal resolves against the same structure');
  assert.equal(scannedRows, afterSearch, 'search and reveal reuse the structure the first search built');
});
