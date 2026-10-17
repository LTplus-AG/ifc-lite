/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { entityTableFromColumns, IfcTypeEnum, RelationshipType } from '@ifc-lite/data';
import { IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { useViewerStore, type FederatedModel } from '@/store';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest.js';
import { emitElementSubtree } from './elementSubtree.js';
import { makeAssemblyGeometry } from './productTree.js';
import { resolveMemberGeometry } from './groupTreeBuilder.js';
import { buildTypeTree } from './treeDataBuilder.js';
import { ownedAggregationRelationships } from '@/utils/entity-ownership.js';
import type { TreeNode } from './types.js';

// #7890: a real parsed relationship may name a missing entity. Its valid,
// not-yet-meshed sibling must remain usable without publishing the missing ID.
const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCELEMENTASSEMBLY('0GUID000000000000000001',$,'Assembly',$,$,$,$,$,$,.NOTDEFINED.);
#2=IFCWALL('0GUID000000000000000002',$,'Rendered wall',$,$,$,$,$,$);
#3=IFCRELAGGREGATES('0GUID000000000000000003',$,$,$,#1,(#2,#4,#2035));
#4=IFCBUILDINGELEMENTPART('0GUID000000000000000004',$,'Later part',$,$,$,$,$,$);
#5=IFCRELAGGREGATES('0GUID000000000000000005',$,$,$,#2035,(#2));
#6=IFCPROJECT('0GUID000000000000000006',$,'Project',$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;`;

function resetModels(): void {
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
}

beforeEach(resetModels);
afterEach(resetModels);

async function installModels(count: number, streaming = false) {
  const models = new Map<string, FederatedModel>();
  for (let index = 0; index < count; index++) {
    const dataStore = await new IfcParser().parseColumnar(
      new TextEncoder().encode(IFC).buffer,
      { disableWorkerScan: true },
    );
    assert.deepEqual(
      dataStore.relationships.getRelated(1, RelationshipType.Aggregates, 'forward'),
      [2, 4, 2035],
      'the real parser preserves the dangling edge being exercised',
    );
    assert.equal(dataStore.entityIndex.byId.has(2035), false);
    const id = `dangling-assembly-${index}`;
    const maxExpressId = getMaxExpressId(dataStore, []);
    const idOffset = useViewerStore.getState().registerModelOffset(id, maxExpressId);
    models.set(id, {
      id,
      name: id,
      ifcDataStore: dataStore,
      geometryResult: null,
      visible: true,
      collapsed: false,
      schemaVersion: 'IFC4',
      loadedAt: 0,
      fileSize: new TextEncoder().encode(IFC).byteLength,
      idOffset,
      maxExpressId,
      loadState: streaming ? 'streaming-geometry' : 'complete',
    });
  }
  useViewerStore.setState({ models, activeModelId: models.keys().next().value ?? null });
  return models;
}

function assertMissingIdRemainsUnowned(modelId: string): void {
  assert.throws(
    () => federationRegistry.toGlobalId(modelId, 2035),
    /Local ID 2035 is not published/,
    'ignoring a dangling relationship must never grant it federation ownership',
  );
}

for (const count of [1, 2]) {
  test(`#7890 tree builders preserve model overlays while filtering descendants in ${count} model(s)`, async () => {
    const models = await installModels(count, true);
    const views = new Map<string, MutablePropertyView>();
    const expected: number[] = [];
    for (const [modelId, model] of models) {
      assert.ok(model.ifcDataStore);
      const view = new MutablePropertyView(null, modelId);
      view.deleteEntity(2);
      views.set(modelId, view);
      const nodes: TreeNode[] = [];
      emitElementSubtree(1, modelId, models, model.ifcDataStore, view, 0,
        new Set([`element-${modelId}-1`]), nodes, new Set(), 'elevation-asc');
      assert.deepEqual(nodes.map(node => node.expressIds), [[1], [4]],
        'spatial rows omit both the deleted child and the dangling child');
      expected.push(useViewerStore.getState().toGlobalId(modelId, 4));
    }
    const tree = buildTypeTree(models, null, { has: () => true }, count > 1,
      new Set(), [], undefined, modelId => views.get(modelId));
    const assemblies = tree.find(node => node.id === 'type-IfcElementAssembly');
    assert.ok(assemblies);
    assert.deepEqual(assemblies.globalIds, expected,
      'class isolation substitutes live unmeshed parts using each builder-supplied overlay');
  });

  for (const direction of ['forward', 'inverse'] as const) {
    test(`#7890 group geometry skips dangling ${direction} relatives in ${count} model(s)`, async () => {
      const models = await installModels(count);
      for (const [modelId, model] of models) {
        assert.ok(model.ifcDataStore);
        const toGlobal = (id: number) => useViewerStore.getState().toGlobalId(modelId, id);
        const member = direction === 'forward' ? 1 : 2;
        const rendered = direction === 'forward' ? 2 : 1;
        assert.ok(model.ifcDataStore.relationships
          .getRelated(member, RelationshipType.Aggregates, direction).includes(2035));
        assert.deepEqual(resolveMemberGeometry(model.ifcDataStore, member, toGlobal, new Set([toGlobal(rendered)])),
          [{ expressId: rendered, globalId: toGlobal(rendered) }]);
        assertMissingIdRemainsUnowned(modelId);
      }
    });
  }

  test(`#7890 assembly geometry survives dangling descendants in ${count} model(s)`, async () => {
    const models = await installModels(count);
    for (const [modelId, model] of models) {
      assert.ok(model.ifcDataStore);
      const state = useViewerStore.getState();
      const owner = state.toGlobalId(modelId, 1);
      const rendered = state.toGlobalId(modelId, 2);
      const geometry = makeAssemblyGeometry(model.ifcDataStore, modelId, models, new Set([rendered]), true);

      assert.equal(geometry.renders('IfcElementAssembly', 1, owner), true,
        'the valid rendered child makes its geometry-less assembly renderable');
      assert.equal(geometry.isOther('IfcElementAssembly', 1, owner), false);
      assert.deepEqual(geometry.parts(1, 'IfcElementAssembly'), [rendered],
        'completed geometry substitutes only the rendered valid descendant');
      assertMissingIdRemainsUnowned(modelId);
    }
  });

  test(`#7890 missing children do not make an unmeshed assembly render in ${count} model(s)`, async () => {
    const models = await installModels(count);
    for (const [modelId, model] of models) {
      assert.ok(model.ifcDataStore);
      const owner = useViewerStore.getState().toGlobalId(modelId, 1);
      const geometry = makeAssemblyGeometry(model.ifcDataStore, modelId, models, new Set(), true);

      assert.equal(geometry.isOther('IfcElementAssembly', 1, owner), true,
        'a completed assembly with no meshed descendants belongs in Other');
      assert.equal(geometry.renders('IfcElementAssembly', 1, owner), false);
      assert.deepEqual(geometry.parts(1, 'IfcElementAssembly'), undefined);
      assertMissingIdRemainsUnowned(modelId);
    }
  });

  test(`#7890 streaming assembly actions retain real unmeshed descendants in ${count} model(s)`, async () => {
    const models = await installModels(count, true);
    for (const [modelId, model] of models) {
      assert.ok(model.ifcDataStore);
      const state = useViewerStore.getState();
      const owner = state.toGlobalId(modelId, 1);
      const expected = [state.toGlobalId(modelId, 2), state.toGlobalId(modelId, 4)];
      const geometry = makeAssemblyGeometry(model.ifcDataStore, modelId, models, new Set(), false);

      assert.equal(geometry.renders('IfcElementAssembly', 1, owner), true);
      assert.equal(geometry.isOther('IfcElementAssembly', 1, owner), false,
        'lack of an uploaded mesh is provisional while geometry streams');
      assert.deepEqual(geometry.parts(1, 'IfcElementAssembly'), expected,
        'hide/isolate targets retain the valid late part but exclude the missing reference');
      assertMissingIdRemainsUnowned(modelId);
    }
  });

  test(`#7890 expanded assembly rows omit missing descendants in ${count} model(s)`, async () => {
    const models = await installModels(count, true);
    for (const [modelId, model] of models) {
      assert.ok(model.ifcDataStore);
      const nodes: TreeNode[] = [];
      emitElementSubtree(1, modelId, models, model.ifcDataStore, undefined, 0,
        new Set([`element-${modelId}-1`]), nodes, new Set(), 'elevation-asc');

      assert.deepEqual(nodes.map(node => node.expressIds), [[1], [2], [4]],
        'real source descendants remain browsable even before their meshes arrive');
      assert.equal(nodes[0].elementCount, 2);
      const state = useViewerStore.getState();
      assert.deepEqual(nodes[0].assemblyChildGlobalIds,
        [state.toGlobalId(modelId, 2), state.toGlobalId(modelId, 4)]);
      assert.deepEqual(nodes.map(node => node.globalIds),
        [1, 2, 4].map(id => [state.toGlobalId(modelId, id)]),
        'every row keeps its owning model identity when local IDs overlap');
      assertMissingIdRemainsUnowned(modelId);
    }
  });
}

test('#7890 ownership follows live source and overlay membership without changing the source graph', async () => {
  const models = await installModels(1);
  const model = [...models.values()][0];
  assert.ok(model.ifcDataStore);
  const view = new MutablePropertyView(null, model.id);
  view.setExpressIdWatermark(2034);
  const created = view.createEntity('IfcBuildingElementPart', []);
  assert.equal(created.expressId, 2035);
  view.deleteEntity(2);
  const relationships = ownedAggregationRelationships(model.ifcDataStore, view);
  assert.deepEqual(relationships?.getRelated(1, RelationshipType.Aggregates, 'forward'), [4, 2035],
    'real unmeshed and live authored endpoints survive; deleted source endpoints do not');
  view.deleteEntity(created.expressId);
  assert.deepEqual(relationships?.getRelated(1, RelationshipType.Aggregates, 'forward'), [4],
    'the same facade observes a subsequent tombstone');
  assert.deepEqual(model.ifcDataStore.relationships.getRelated(1, RelationshipType.Aggregates, 'forward'), [2, 4, 2035]);
  assertMissingIdRemainsUnowned(model.id);
});

test('#7890 table-backed ownership uses actual rows rather than displayed classes', async () => {
  const models = await installModels(1);
  const model = [...models.values()][0];
  assert.ok(model.ifcDataStore);
  const store = model.ifcDataStore;
  // An older enum-only source table can own a row whose class is unknown.
  const entities = entityTableFromColumns({ ...store.entities, rawTypeName: undefined,
    typeEnum: Uint16Array.from(store.entities.typeEnum, (type, row) =>
      store.entities.expressId[row] === 4 ? IfcTypeEnum.Unknown : type),
  }, store.strings);
  const tableBacked = { ...store, entities, entityIndex: { ...store.entityIndex, byId: new Map() } };
  entities.setTypeOverride(2035, 'IfcWall');
  assert.equal(entities.getTypeName(4), 'Unknown');
  assert.equal(entities.getTypeName(2035), 'IfcWall');
  const relationships = ownedAggregationRelationships(tableBacked);
  assert.deepEqual(relationships?.getRelated(1, RelationshipType.Aggregates, 'forward'), [2, 4],
    'an unknown-class real row survives and a display override cannot publish an absent row');
  assertMissingIdRemainsUnowned(model.id);
});
