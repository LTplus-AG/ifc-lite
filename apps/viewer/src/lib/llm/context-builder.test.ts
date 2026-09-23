/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { getModelContext, parseCSV } from './context-builder.js';

// Bonsai/IfcOpenShell IFC4 sample: #1222 is an IfcWall and #42 a storey.
const SAMPLE = new URL('../../../public/samples/hello-wall.ifc', import.meta.url);

async function parsedStore() {
  const bytes = await readFile(SAMPLE);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

test('parseCSV preserves embedded newlines inside quoted fields', () => {
  const csv = 'Name,Notes\n"Lobby","Line 1\nLine 2"\n"Office","Single line"';

  const parsed = parseCSV(csv);

  assert.deepEqual(parsed.columns, ['Name', 'Notes']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0]?.Notes, 'Line 1\nLine 2');
  assert.equal(parsed.rows[1]?.Notes, 'Single line');
});

test('LLM context counts effective entities per model after live creates, deletes and retypes (#5249)', async () => {
  const store = await parsedStore();
  const viewA = new MutablePropertyView(store.properties, 'a');
  const viewB = new MutablePropertyView(store.properties, 'b');
  viewA.setExpressIdWatermark(2000);
  viewB.setExpressIdWatermark(2000);
  const original = useViewerStore.getState();
  useViewerStore.setState({
    models: new Map([
      ['a', { ...fixtureModel('a', { idOffset: 1_000_000 }), ifcDataStore: store }],
      ['b', { ...fixtureModel('b', { idOffset: 2_000_000 }), ifcDataStore: store }],
    ]),
    activeModelId: 'a',
    mutationViews: new Map([['a', viewA], ['b', viewB]]),
  });
  try {
    const before = getModelContext();
    const baseCount = store.entities.count;
    const baseWalls = before.typeCounts.IfcWall ?? 0;
    assert.deepEqual(before.models.map((model) => model.entityCount), [baseCount, baseCount]);
    assert.ok(baseWalls >= 2, 'each parsed model contributes its source wall');

    viewA.deleteEntity(1222);
    viewB.createEntity('IfcDoor', [null, null, 'New door']);
    viewB.setEntityType(1222, 'IfcBuildingElementProxy');

    const after = getModelContext();
    assert.deepEqual(after.models.map((model) => model.entityCount), [baseCount - 1, baseCount + 1]);
    assert.equal(after.typeCounts.IfcWall ?? 0, baseWalls - 2);
    assert.equal(after.typeCounts.IfcDoor, (before.typeCounts.IfcDoor ?? 0) + 1);
    assert.equal(after.typeCounts.IfcBuildingElementProxy,
      (before.typeCounts.IfcBuildingElementProxy ?? 0) + 1);
  } finally {
    useViewerStore.setState({
      models: original.models,
      activeModelId: original.activeModelId,
      mutationViews: original.mutationViews,
    });
  }
});

test('LLM context refreshes legacy single-model counts without a Zustand version bump (#5249)', async () => {
  const store = await parsedStore();
  const view = new MutablePropertyView(store.properties, '__legacy__');
  const original = useViewerStore.getState();
  useViewerStore.setState({
    models: new Map(),
    activeModelId: null,
    ifcDataStore: store,
    mutationViews: new Map([['__legacy__', view]]),
  });
  try {
    const before = getModelContext();
    view.deleteEntity(1222);
    const after = getModelContext();
    assert.equal(after.models[0]?.entityCount, before.models[0]!.entityCount - 1);
    assert.equal(after.typeCounts.IfcWall ?? 0, (before.typeCounts.IfcWall ?? 0) - 1);
  } finally {
    useViewerStore.setState({
      models: original.models,
      activeModelId: original.activeModelId,
      ifcDataStore: original.ifcDataStore,
      mutationViews: original.mutationViews,
    });
  }
});
