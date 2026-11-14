/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A retype writes an EntityTable display override (`syncTypeOverride`).
 * Clearing the edits must drop it too, or `getTypeName` / `getExactTypeName`
 * keep reporting a class no edit backs any more (Part of #9668).
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store/index.js';
import { StringTable } from '@ifc-lite/data';
import { ServerEntityIndex, type DataModel } from '@ifc-lite/server-client';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { buildEntityTable } from '../../utils/serverEntityTable';

const FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
`;

const initial = useViewerStore.getState();
const store = () => useViewerStore.getState();

async function install(modelIds: string[]): Promise<Map<string, IfcDataStore>> {
  const stores = new Map<string, IfcDataStore>();
  for (const id of modelIds) {
    stores.set(id, await new IfcParser().parseColumnar(new TextEncoder().encode(FIXTURE).buffer as ArrayBuffer, { disableWorkerScan: true }));
  }
  useViewerStore.setState({
    ...fixtureModels(...modelIds.map(id => ({ ...fixtureModel(id), ifcDataStore: stores.get(id)! }))),
    mutationViews: new Map(modelIds.map(id => [id, new MutablePropertyView(null, id)])),
    undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(),
    mutationVersion: 0, changeSets: new Map(), activeChangeSetId: null, editEnabled: true, collabRoomId: null,
  });
  return stores;
}

function retype(modelId: string, ds: IfcDataStore): void {
  assert.ok(store().setEntityType(modelId, 10, 'IfcColumn'));
  assert.equal(ds.entities.getTypeName(10), 'IfcColumn', 'the retype reached the EntityTable');
  assert.equal(ds.entities.getExactTypeName?.(10), 'IfcColumn');
}

function assertSourceClass(ds: IfcDataStore): void {
  assert.equal(ds.entities.getTypeName(10), 'IfcWall');
  assert.equal(ds.entities.getExactTypeName?.(10), 'IfcWall');
}

describe('clearing edits drops EntityTable type overrides', () => {
  beforeEach(() => useViewerStore.setState(initial));
  afterEach(() => useViewerStore.setState(initial));

  it('clearMutations restores the parsed class for that model only', async () => {
    const stores = await install(['A', 'B']);
    retype('A', stores.get('A')!);
    retype('B', stores.get('B')!);
    store().clearMutations('A');
    assertSourceClass(stores.get('A')!);
    assert.equal(stores.get('B')!.entities.getTypeName(10), 'IfcColumn', 'another model keeps its retype');
    // B is the active store, so the legacy fallback would land on its table.
    useViewerStore.setState({
      ifcDataStore: stores.get('B')!,
      mutationViews: new Map([...store().mutationViews, ['not-loaded', new MutablePropertyView(null, 'not-loaded')]]),
    });
    store().clearMutations('not-loaded');
    assert.equal(stores.get('B')!.entities.getTypeName(10), 'IfcColumn', 'a view id with no model never resets a loaded table');
  });

  it('clearMutations also drops the override of a created entity that was retyped then deleted', async () => {
    const stores = await install(['A']);
    const ds = stores.get('A')!;
    const view = store().mutationViews.get('A')!;
    const created = view.createEntity('IFCWALL', []);
    assert.ok(store().setEntityType('A', created.expressId, 'IfcColumn'));
    view.deleteEntity(created.expressId);
    assert.equal(view.getTypeMutations().size, 0, 'the retype left the view, so the view cannot name it');
    store().clearMutations('A');
    const reused = view.createEntity('IFCBEAM', []);
    assert.equal(reused.expressId, created.expressId, 'clearing reuses the id');
    assert.notEqual(ds.entities.getTypeName(reused.expressId), 'IfcColumn');
  });

  it('clearAllMutations restores the parsed class in every model', async () => {
    const stores = await install(['A', 'B']);
    retype('A', stores.get('A')!);
    retype('B', stores.get('B')!);
    store().clearAllMutations();
    assertSourceClass(stores.get('A')!);
    assertSourceClass(stores.get('B')!);
  });
});

describe('EntityTable.clearTypeOverrides', () => {
  it('the server-hydrated table drops every override too', () => {
    const rows = [{ entity_id: 10, type_name: 'IFCWALL', global_id: 'G'.padEnd(22, 'x'), name: 'W', has_geometry: false }];
    const { entities } = buildEntityTable({ entities: ServerEntityIndex.fromRows(rows) } as unknown as DataModel, new StringTable());
    entities.setTypeOverride(10, 'IFCCOLUMN');
    assert.equal(entities.getTypeName(10), 'IfcColumn');
    const revision = entities.typeRevision ?? 0;
    entities.clearTypeOverrides?.();
    assert.equal(entities.getTypeName(10), 'IfcWall');
    assert.ok((entities.typeRevision ?? 0) > revision, 'class caches keyed on typeRevision must see the reset');
  });
});
