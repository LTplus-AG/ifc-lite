/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { entityTableFromColumns, IfcTypeEnum, RelationshipType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { buildMaterialUsageIndex, IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import {
  buildIfcTypeTree, buildMaterialTree, buildTreeData,
  buildUnifiedStoreys, getUnifiedStoreyElements,
} from './treeDataBuilder.js';
import type { TreeNode } from './types.js';
import { buildTreeForGrouping } from './revealGlobalId.js';
import { buildGroupTree } from './groupTreeBuilder.js';

// #7890: relationship candidates are file supplied, whereas federation
// publication requires an actual source or live authored entity. Wall #8 is
// real but not yet meshed; #2035 has no row in any of these relationships.
const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0GUID000000000000000001',$,'Project',$,$,$,$,$,$);
#2=IFCSITE('0GUID000000000000000002',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0GUID000000000000000003',$,'Building',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('0GUID000000000000000004',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCWALL('0GUID000000000000000005',$,'Rendered wall',$,$,$,$,$,$);
#6=IFCWALLTYPE('0GUID000000000000000006',$,'Type',$,$,$,$,$,$,.NOTDEFINED.);
#7=IFCMATERIAL('Concrete',$,$);
#8=IFCWALL('0GUID000000000000000008',$,'Later wall',$,$,$,$,$,$);
#10=IFCRELAGGREGATES('0GUID000000000000000010',$,$,$,#1,(#2));
#11=IFCRELAGGREGATES('0GUID000000000000000011',$,$,$,#2,(#3));
#12=IFCRELAGGREGATES('0GUID000000000000000012',$,$,$,#3,(#4));
#13=IFCRELCONTAINEDINSPATIALSTRUCTURE('0GUID000000000000000013',$,$,$,(#5,#8,#2035),#4);
#14=IFCRELDEFINESBYTYPE('0GUID000000000000000014',$,$,$,(#5,#8,#2035),#6);
#15=IFCRELASSOCIATESMATERIAL('0GUID000000000000000015',$,$,$,(#5,#8,#2035),#7);
ENDSEC;
END-ISO-10303-21;`;

const expanded = { has: () => true };

function resetModels(): void {
  useViewerStore.getState().clearAllModels();
  useViewerStore.setState({ mutationViews: new Map(), storeEditors: new Map() });
}

beforeEach(resetModels);
afterEach(resetModels);

async function installModels(count: number, complete = false, extraEntities = ''): Promise<Map<string, FederatedModel>> {
  const entries: FederatedModel[] = [];
  for (let index = 0; index < count; index++) {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(IFC.replace('ENDSEC;\nEND-ISO', `${extraEntities}\nENDSEC;\nEND-ISO`)).buffer,
      { disableWorkerScan: true },
    );
    assert.deepEqual(store.relationships.getRelated(6, RelationshipType.DefinesByType, 'forward'),
      [5, 8, 2035], 'the real parser preserves all type relationship candidates');
    assert.deepEqual(store.onDemandMaterialMap?.get(2035), [7],
      'the raw material association preserves the missing endpoint');
    assert.deepEqual(buildMaterialUsageIndex(store).get(7)?.entries.map(entry => entry.entityId),
      [5, 8, 2035], 'raw usage is not evidence that an entity exists');
    assert.deepEqual(store.spatialHierarchy?.byStorey.get(4), [5, 8, 2035],
      'the parsed spatial lookup retains the malformed relationship');
    assert.equal(store.entityIndex.byId.has(2035), false);
    const id = `dangling-candidates-${index}`;
    const maxExpressId = getMaxExpressId(store, []);
    const idOffset = useViewerStore.getState().registerModelOffset(id, maxExpressId);
    entries.push({
      ...fixtureModel(id), ifcDataStore: store, idOffset, maxExpressId,
      loadState: complete ? 'complete' : 'streaming-geometry',
    });
  }
  const state = fixtureModels(...entries);
  useViewerStore.setState(state);
  return state.models;
}

function globalIds(models: Map<string, FederatedModel>, ids: number[]): number[] {
  return [...models.keys()].flatMap(modelId =>
    ids.map(id => useViewerStore.getState().toGlobalId(modelId, id)));
}

function assertMissingUnpublished(models: Map<string, FederatedModel>, nodes: TreeNode[] = []): void {
  assert.equal(nodes.some(node => node.expressIds.includes(2035)), false,
    'no visible row or action list admits the missing relationship endpoint');
  for (const modelId of models.keys()) {
    assert.throws(() => federationRegistry.toGlobalId(modelId, 2035),
      /Local ID 2035 is not published/,
      'tree construction cannot grant federation ownership to a candidate');
  }
}

function assertTypedMembers(
  models: Map<string, FederatedModel>, nodes: TreeNode[], ids: number[],
): void {
  const group = nodes.find(node => node.id === 'typeclass-IfcWallType');
  assert.ok(group);
  assert.equal(group.elementCount, models.size * ids.length);
  assert.deepEqual(group.globalIds, globalIds(models, ids),
    'the class action keeps the actual owning model when local IDs overlap');
  for (const modelId of models.keys()) {
    const row = nodes.find(node => node.id === `ifctype-${modelId}-6`);
    assert.ok(row);
    assert.deepEqual(row.expressIds, ids);
    assert.deepEqual(row.globalIds, ids.map(id => useViewerStore.getState().toGlobalId(modelId, id)));
    const children = nodes.filter(node => node.modelId === modelId
      && node.type === 'element' && node.depth === 2);
    assert.deepEqual(children.flatMap(node => node.expressIds).sort((a, b) => a - b), ids,
      'the expanded type row exposes exactly its live admitted occurrences');
  }
  assertMissingUnpublished(models, nodes);
}

for (const count of [1, 2]) {
  for (const complete of [false, true]) {
    const phase = complete ? 'complete' : 'streaming';
    test(`#7890 By Type rejects missing candidates with ${count} ${phase} model(s)`, async () => {
      const models = await installModels(count, complete);
      const nodes = buildIfcTypeTree(models, null, expanded, count > 1,
        new Set(globalIds(models, [5])), complete ? new Set(models.keys()) : new Set());
      assertTypedMembers(models, nodes, complete ? [5] : [5, 8]);
      if (complete) {
        const other = nodes.find(node => node.id === 'typeclass-other');
        assert.ok(other);
        assert.deepEqual(other.globalIds, globalIds(models, [8]),
          'the real unmeshed occurrence remains browsable in Other after completion');
      }
      for (const model of models.values()) {
        assert.deepEqual(model.ifcDataStore?.relationships
          .getRelated(6, RelationshipType.DefinesByType, 'forward'), [5, 8, 2035],
        'consumer filtering leaves the raw relationship evidence intact');
      }
    });

    test(`#7890 material grouping excludes tombstoned users with ${count} ${phase} model(s)`, async () => {
      const models = await installModels(count, complete);
      const views = new Map<string, MutablePropertyView>();
      // Local IDs overlap across models: deleting one model's wall cannot
      // suppress a live wall in the other model's material action.
      const deletedModelId = models.keys().next().value;
      assert.ok(deletedModelId);
      const view = new MutablePropertyView(null, deletedModelId);
      view.deleteEntity(5);
      views.set(deletedModelId, view);
      useViewerStore.setState({ mutationViews: views });
      const nodes = buildTreeForGrouping('material', models, null, expanded, count > 1,
        [], 'elevation-desc', new Set(globalIds(models, [5, 8])), new Set(), [], 'all',
        complete ? new Set(models.keys()) : new Set(), new Map(), views);
      assert.equal(nodes.length, count);
      for (const modelId of models.keys()) {
        const material = nodes.find(node => node.modelId === modelId);
        assert.ok(material);
        const expected: number[] = modelId === deletedModelId ? [8] : [5, 8];
        assert.deepEqual(material.expressIds, expected);
        assert.deepEqual(material.globalIds,
          expected.map(id => useViewerStore.getState().toGlobalId(modelId, id)));
        assert.equal(material.elementCount, expected.length);
        assert.deepEqual(buildMaterialUsageIndex(models.get(modelId)!.ifcDataStore!)
          .get(7)?.entries.map(entry => entry.entityId), [5, 8, 2035],
        'overlay filtering does not rewrite raw source material associations');
      }
      assertMissingUnpublished(models, nodes);
    });

    test(`#7890 materials reject missing candidates with ${count} ${phase} model(s)`, async () => {
      const models = await installModels(count, complete);
      const nodes = buildMaterialTree(models, null, expanded, count > 1,
        new Set(globalIds(models, [5])), complete ? new Set(models.keys()) : new Set());
      assert.equal(nodes.length, count);
      const expected = complete ? [5] : [5, 8];
      for (const modelId of models.keys()) {
        const material = nodes.find(node => node.modelId === modelId);
        assert.ok(material);
        assert.equal(material.name, 'Concrete');
        assert.equal(material.entityExpressId, 7);
        assert.deepEqual(material.expressIds, expected);
        assert.deepEqual(material.globalIds,
          expected.map(id => useViewerStore.getState().toGlobalId(modelId, id)));
        assert.equal(material.elementCount, expected.length);
        const store = models.get(modelId)?.ifcDataStore;
        assert.ok(store);
        assert.deepEqual(store.onDemandMaterialMap?.get(2035), [7]);
        assert.deepEqual(buildMaterialUsageIndex(store).get(7)?.entries.map(entry => entry.entityId),
          [5, 8, 2035], 'building the action list preserves raw material usage evidence');
      }
      assertMissingUnpublished(models, nodes);
    });
  }

  test(`#7890 spatial rows retain real unmeshed members with ${count} model(s)`, async () => {
    const models = await installModels(count);
    const geometry = new Set(globalIds(models, [5]));
    const unified = buildUnifiedStoreys(models, 'elevation-desc', geometry, new Set());
    const nodes = buildTreeData(models, null, expanded, count > 1, unified,
      'elevation-desc', geometry, new Set());
    for (const modelId of models.keys()) {
      const rows = nodes.filter(node => node.type === 'element' && node.modelId === modelId);
      assert.deepEqual([...new Set(rows.flatMap(node => node.expressIds))].sort((a, b) => a - b), [5, 8],
        'expanded containment includes the real late wall without admitting a missing row');
      for (const row of rows) {
        assert.deepEqual(row.globalIds,
          row.expressIds.map(id => useViewerStore.getState().toGlobalId(modelId, id)));
      }
      assert.deepEqual(models.get(modelId)?.ifcDataStore?.spatialHierarchy?.byStorey.get(4),
        [5, 8, 2035], 'the spatial consumer does not rewrite raw containment evidence');
    }
    if (count > 1) {
      assert.equal(unified.length, 1);
      assert.equal(unified[0].totalElements, count * 2);
      assert.deepEqual(unified[0].storeys.map(storey => storey.elements), [[5, 8], [5, 8]]);
      assert.deepEqual(getUnifiedStoreyElements(unified[0], models), globalIds(models, [5, 8]),
        'unified hide/isolate actions preserve the unmeshed wall in each model');
    }
    assertMissingUnpublished(models, nodes);
  });

  test(`#7890 By Type admits live queued endpoints with ${count} model overlay(s)`, async () => {
    const models = await installModels(count);
    const views = new Map<string, MutablePropertyView>();
    for (const modelId of models.keys()) {
      const view = new MutablePropertyView(null, modelId);
      view.setExpressIdWatermark(15);
      const wall = view.createEntity('IfcWall', ['0GUID000000000000000016', null, 'Authored wall']);
      assert.equal(wall.expressId, 16);
      const relation = view.createEntity('IfcRelDefinesByType',
        ['0GUID000000000000000017', null, null, null, [16, 2035], 6]);
      assert.equal(relation.expressId, 17);
      view.deleteEntity(5);
      views.set(modelId, view);
    }
    // The same real views back canonical publication and tree admission.
    useViewerStore.setState({ mutationViews: views });
    const nodes = buildIfcTypeTree(models, null, expanded, count > 1,
      new Set(), new Set(), modelId => views.get(modelId));
    assertTypedMembers(models, nodes, [8, 16]);
    assert.equal(nodes.some(node => node.expressIds.includes(5)), false,
      'a source occurrence tombstone removes its original type binding');
    for (const modelId of models.keys()) {
      assert.ok(nodes.some(node => node.type === 'element' && node.modelId === modelId
        && node.name === 'Authored wall' && node.expressIds[0] === 16));
    }
  });
}

test('#7890 unified byStorey fallback excludes missing candidates without a project tree', async () => {
  const models = await installModels(2);
  for (const [modelId, model] of models) {
    assert.ok(model.ifcDataStore?.spatialHierarchy);
    const hierarchy = { ...model.ifcDataStore.spatialHierarchy };
    // Native/partial sources can supply lookup maps before the project tree.
    // Keep the actual parser's maps and entity rows while exercising that shape.
    Object.defineProperty(hierarchy, 'project', { value: undefined });
    models.set(modelId, { ...model, ifcDataStore: { ...model.ifcDataStore, spatialHierarchy: hierarchy } });
  }
  useViewerStore.setState({ models });
  const unified = buildUnifiedStoreys(models);
  assert.equal(unified.length, 1);
  assert.equal(unified[0].totalElements, 4);
  assert.deepEqual(unified[0].storeys.map(storey => storey.elements), [[5, 8], [5, 8]]);
  assert.deepEqual(getUnifiedStoreyElements(unified[0], models), globalIds(models, [5, 8]));
  for (const model of models.values()) {
    assert.deepEqual(model.ifcDataStore?.spatialHierarchy?.byStorey.get(4), [5, 8, 2035]);
  }
  assertMissingUnpublished(models);
});

// Direct group members convert before any nested geometry traversal. Display
// metadata is not publication evidence, even when it supplies a known class.
const GROUP_ENTITIES = `
#16=IFCGROUP('0GUID000000000000000016',$,'Mixed group',$,$);
#17=IFCRELASSIGNSTOGROUP('0GUID000000000000000017',$,$,$,(#5,#8,#2035),$,#16);
#18=IFCGROUP('0GUID000000000000000018',$,'Missing-only group',$,$);
#19=IFCRELASSIGNSTOGROUP('0GUID000000000000000019',$,$,$,(#2035),$,#18);`;

for (const count of [1, 2]) {
  for (const tableBacked of [false, true]) {
    test(`#7890 direct group actions reject display-only endpoints with ${count} ${tableBacked ? 'table-backed' : 'indexed'} model(s)`, async () => {
      const models = await installModels(count, false, GROUP_ENTITIES);
      for (const [modelId, model] of models) {
        assert.ok(model.ifcDataStore);
        const store = model.ifcDataStore;
        const entities = tableBacked ? entityTableFromColumns({
          ...store.entities, rawTypeName: undefined,
          typeEnum: Uint16Array.from(store.entities.typeEnum, (type, row) =>
            store.entities.expressId[row] === 8 ? IfcTypeEnum.Unknown : type),
        }, store.strings) : store.entities;
        entities.setTypeOverride(2035, 'IfcWall');
        assert.equal(entities.getTypeName(2035), 'IfcWall',
          'the real table permits display metadata for an absent ID');
        if (tableBacked) {
          assert.equal(entities.getTypeName(8), 'Unknown');
          models.set(modelId, { ...model, ifcDataStore: {
            ...store, entities, entityIndex: { ...store.entityIndex, byId: new Map() },
          } });
        }
      }
      useViewerStore.setState({ models });
      const nodes = buildGroupTree(models, null, expanded, count > 1,
        new Set(globalIds(models, [5])));
      for (const modelId of models.keys()) {
        const group = nodes.find(node => node.modelId === modelId && node.entityExpressId === 16);
        assert.ok(group);
        assert.equal(group.elementCount, 2);
        assert.deepEqual(group.memberGlobalIds,
          [5, 8].map(id => useViewerStore.getState().toGlobalId(modelId, id)),
          'direct actions retain every real member, including an unmeshed unknown-class row');
        assert.deepEqual(group.globalIds, [useViewerStore.getState().toGlobalId(modelId, 5)]);
        const rows = nodes.filter(node => node.modelId === modelId && node.type === 'group-member');
        assert.deepEqual(rows.flatMap(node => node.expressIds).sort((a, b) => a - b), [5, 8]);
        if (tableBacked) assert.equal(rows.find(node => node.expressIds[0] === 8)?.ifcType, 'Unknown');
        assert.equal(nodes.some(node => node.modelId === modelId && node.entityExpressId === 18), false,
          'a group containing only absent endpoints has no selectable member');
        assert.deepEqual(models.get(modelId)?.ifcDataStore?.relationships
          .getRelated(16, RelationshipType.AssignsToGroup, 'forward'), [5, 8, 2035],
        'admission leaves the raw group relationship intact');
      }
      assertMissingUnpublished(models, nodes);
    });
  }

  test(`#7890 direct group actions honor created and deleted endpoints in ${count} model overlay(s)`, async () => {
    const models = await installModels(count, false, GROUP_ENTITIES);
    const views = new Map<string, MutablePropertyView>();
    for (const modelId of models.keys()) {
      const view = new MutablePropertyView(null, modelId);
      view.setExpressIdWatermark(19);
      const wall = view.createEntity('IfcWall', ['0GUID000000000000000020', null, 'Authored group wall']);
      assert.equal(wall.expressId, 20);
      view.createEntity('IfcRelAssignsToGroup',
        ['0GUID000000000000000021', null, null, null, [20, 2035], null, 16]);
      view.deleteEntity(5);
      views.set(modelId, view);
    }
    useViewerStore.setState({ mutationViews: views });
    const nodes = buildGroupTree(models, null, expanded, count > 1,
      new Set(globalIds(models, [20])), 'all', modelId => views.get(modelId));
    for (const modelId of models.keys()) {
      const group = nodes.find(node => node.modelId === modelId && node.entityExpressId === 16);
      assert.ok(group);
      assert.deepEqual(group.memberGlobalIds,
        [8, 20].map(id => useViewerStore.getState().toGlobalId(modelId, id)));
      assert.deepEqual(group.globalIds, [useViewerStore.getState().toGlobalId(modelId, 20)]);
      assert.ok(nodes.some(node => node.modelId === modelId && node.type === 'group-member'
        && node.name === 'Authored group wall' && node.expressIds[0] === 20));
      assert.equal(nodes.some(node => node.modelId === modelId && node.expressIds.includes(5)), false);
    }
    assertMissingUnpublished(models, nodes);
  });
}

for (const overlayKey of ['__legacy__', 'legacy']) {
  test(`#7890 legacy material rows honor tombstones under ${overlayKey}`, async () => {
    const models = await installModels(1);
    const store = [...models.values()][0].ifcDataStore;
    assert.ok(store);
    const view = new MutablePropertyView(null, overlayKey);
    view.deleteEntity(5);
    const nodes = buildMaterialTree(new Map(), store, expanded, false,
      undefined, undefined, undefined, key => key === overlayKey ? view : undefined);
    assert.equal(nodes.length, 1);
    assert.deepEqual(nodes[0].expressIds, [8]);
    assert.deepEqual(nodes[0].globalIds, [8]);
    assert.equal(nodes[0].elementCount, 1);
  });
}
