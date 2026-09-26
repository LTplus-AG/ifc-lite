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

it('keeps the #5886 class builder invocation count at one through repeated expansion toggles', () => {
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
  assert.ok(scannedRows > 0, 'the structural builder read real entity rows once');
  const initialScans = scannedRows;

  for (let i = 0; i < 8; i++) {
    act(() => tree.toggleExpand('type-IfcWall'));
    assert.equal(tree.treeData.length, i % 2 === 0 ? 3 : 1, 'only the visible row projection changes');
  }
  assert.equal(scannedRows, initialScans, 'expansion must never invoke the class builder again');
});
