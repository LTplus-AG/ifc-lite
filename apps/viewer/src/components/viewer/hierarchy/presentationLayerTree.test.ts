/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { IfcParser, extractClassificationsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { resolveEntityRef, useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { buildPresentationLayerTree } from './presentationLayerTree.js';
import { hierarchyRowSelection } from './rowSelection.js';
import { collectAnnotationEntityIds } from './hierarchyGeometry.js';
import { buildTreeForGrouping } from './revealGlobalId.js';

// #7619: real STEP ownership, including an assembly whose drawable geometry
// belongs to a part, exercises both domain resolution and hierarchy projection.
const IFC = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCELEMENTASSEMBLY('0GUID000000000000000001',$,'Assembly',$,$,$,#10,$,$,.NOTDEFINED.);
#2=IFCWALL('0GUID000000000000000002',$,'Wall',$,$,$,#11,$,$);
#3=IFCBUILDINGELEMENTPART('0GUID000000000000000003',$,'Part',$,$,$,#12,$,$);
#4=IFCWALL('0GUID000000000000000004',$,'Without mesh',$,$,$,#13,$,$);
#10=IFCPRODUCTDEFINITIONSHAPE($,$,(#20));
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#21));
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));
#13=IFCPRODUCTDEFINITIONSHAPE($,$,(#23));
#20=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#30));
#21=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#31));
#22=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));
#23=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#33));
#30=IFCEXTRUDEDAREASOLID($,$,$,1.);
#31=IFCEXTRUDEDAREASOLID($,$,$,1.);
#32=IFCEXTRUDEDAREASOLID($,$,$,1.);
#33=IFCEXTRUDEDAREASOLID($,$,$,1.);
#50=IFCPRESENTATIONLAYERASSIGNMENT('Repeated',$,(#20,#20,#21),'A');
#51=IFCPRESENTATIONLAYERWITHSTYLE('Repeated',$,(#20),'B',.F.,.F.,.F.,());
#52=IFCPRESENTATIONLAYERASSIGNMENT('No geometry',$,(#23),$);
#53=IFCPRESENTATIONLAYERASSIGNMENT('Dangling',$,(#999),$);
#90=IFCRELAGGREGATES('0GUID000000000000000090',$,$,$,#1,(#3));
ENDSEC;
END-ISO-10303-21;`;
const ALL = { has: () => true };

async function parse(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(IFC).buffer,
    { disableWorkerScan: true });
}

function sharedModel(id: string, store: IfcDataStore): FederatedModel {
  return { ...fixtureModel(id), ifcDataStore: store, maxExpressId: 100 };
}

afterEach(() => useViewerStore.getState().clearAllModels());

test('#7619 legacy rows deduplicate memberships and select owners while isolating assembly parts', async () => {
  const nodes = buildPresentationLayerTree(new Map(), await parse(), ALL,
    new Set([2, 3]), new Set(['legacy']));
  const header = nodes.find(row => row.entityExpressId === 50);
  assert.ok(header);
  assert.deepEqual(header.memberGlobalIds, [1, 2]);
  assert.deepEqual(new Set(header.globalIds), new Set([2, 3]), 'assembly part replaces owner for visibility');
  assert.equal(header.elementCount, 2, 'repeated AssignedItems do not repeat product rows');
  assert.deepEqual(hierarchyRowSelection(header, new Map(), globalId => ({ modelId: 'legacy', expressId: globalId })), [
    { modelId: 'legacy', expressId: 1, globalId: 1 },
    { modelId: 'legacy', expressId: 2, globalId: 2 },
  ]);
  const assemblies = nodes.filter(row => row.type === 'element' && row.expressIds[0] === 1);
  assert.equal(assemblies.length, 2, 'one product can occur under two assignments');
  assert.equal(new Set(assemblies.map(row => row.id)).size, 2);
  assert.deepEqual(assemblies[0].assemblyChildGlobalIds, [3]);
  assert.equal(nodes.some(row => row.entityExpressId === 53), false, 'dangling-only layer is omitted');
  const meshless = nodes.find(row => row.type === 'element' && row.expressIds[0] === 4);
  assert.equal(meshless?.noGeometry, true, 'meshless products remain browsable');
});

test('#7619 federation qualifies same assignment and product IDs without merging same-name layers', async () => {
  const state = useViewerStore.getState();
  const a = sharedModel('presentation-builder-a', await parse());
  const b = sharedModel('presentation-builder-b', await parse());
  a.idOffset = state.registerModelOffset(a.id, 100);
  b.idOffset = state.registerModelOffset(b.id, 100);
  const { models, activeModelId } = fixtureModels(a, b);
  useViewerStore.setState({ models, activeModelId, mutationViews: new Map() });
  const nodes = buildPresentationLayerTree(models, null, ALL,
    new Set([a.idOffset + 2, a.idOffset + 3, b.idOffset + 2, b.idOffset + 3]), new Set([a.id, b.id]));
  const headers = nodes.filter(row => row.entityExpressId === 50);
  assert.equal(headers.length, 2);
  assert.equal(new Set(headers.map(row => row.id)).size, 2);
  for (const [index, model] of [a, b].entries()) {
    const row = headers[index];
    assert.deepEqual(row.memberGlobalIds, [model.idOffset + 1, model.idOffset + 2]);
    assert.deepEqual(hierarchyRowSelection(row, models, resolveEntityRef).map(ref => [ref.modelId, ref.expressId]),
      [[model.id, 1], [model.id, 2]]);
  }
});

test('#7619 shared source store remains separate for models with distinct registered ID spaces', async () => {
  const store = await parse();
  const state = useViewerStore.getState();
  const a = sharedModel('presentation-shared-source-a', store);
  const b = sharedModel('presentation-shared-source-b', store);
  a.idOffset = state.registerModelOffset(a.id, 100);
  b.idOffset = state.registerModelOffset(b.id, 100);
  assert.notEqual(a.idOffset, b.idOffset, 'the two models use genuinely distinct published ranges');
  const { models, activeModelId } = fixtureModels(a, b);
  useViewerStore.setState({ models, activeModelId, mutationViews: new Map() });
  const globalId = (model: FederatedModel, id: number) => useViewerStore.getState().toGlobalId(model.id, id);
  const geometryIds = new Set([a, b].flatMap(model => [globalId(model, 2), globalId(model, 3)]));
  const nodes = buildPresentationLayerTree(models, null, ALL, geometryIds, new Set([a.id, b.id]));
  const headers = nodes.filter(row => row.entityExpressId === 50);
  assert.equal(headers.length, 2, 'shared source identity must not merge distinct model instances');
  assert.equal(new Set(headers.map(row => row.id)).size, 2);
  for (const model of [a, b]) {
    const header = headers.find(row => row.modelId === model.id);
    assert.ok(header);
    assert.deepEqual(header.modelIds, [model.id]);
    assert.deepEqual(header.memberGlobalIds, [globalId(model, 1), globalId(model, 2)]);
    assert.deepEqual(new Set(header.globalIds), new Set([globalId(model, 2), globalId(model, 3)]));
    assert.deepEqual(hierarchyRowSelection(header, models, resolveEntityRef).map(ref => [ref.modelId, ref.expressId]),
      [[model.id, 1], [model.id, 2]], 'selection and assembly visibility stay in the owning model ID space');
  }
});

test('#7619 shared IFCX store emits one unattributed tree and uses any owner geometry readiness', async () => {
  const store = await parse();
  // IFCX composition has shared zero-offset IDs; the first owner can be a
  // metadata-only overlay while a later owner supplies the geometry.
  const { models } = fixtureModels(sharedModel('presentation-builder-overlay', store), sharedModel('presentation-builder-base', store));
  const nodes = buildPresentationLayerTree(models, null, ALL, new Set([2, 3]), new Set(['presentation-builder-base']));
  const headers = nodes.filter(row => row.type === 'presentation-layer');
  assert.equal(headers.length, 3, 'shared store is projected once');
  for (const row of nodes) {
    assert.deepEqual(row.modelIds, ['presentation-builder-overlay', 'presentation-builder-base']);
    assert.equal(row.modelId, undefined, 'no false attribution to the first IFCX layer');
  }
  const empty = headers.find(row => row.entityExpressId === 52);
  assert.ok(empty);
  assert.deepEqual(empty.globalIds, [], 'later owner readiness prevents optimistic meshless targets');
  assert.equal(empty.noGeometry, true);
  assert.equal(nodes.find(row => row.type === 'element' && row.expressIds[0] === 4)?.noGeometry, true);
});

test('#7619 streaming does not prematurely mark product memberships as geometry-less', async () => {
  const nodes = buildPresentationLayerTree(new Map(), await parse(), ALL, new Set(), new Set());
  const header = nodes.find(row => row.entityExpressId === 52);
  assert.ok(header);
  assert.deepEqual(header.globalIds, [4]);
  assert.equal(header.noGeometry, false);
  assert.equal(nodes.find(row => row.type === 'element' && row.expressIds[0] === 4)?.noGeometry, false);
});

test('#7619 legacy overlay edits preserve authored meshless products and remove deleted members', async () => {
  const store = await parse();
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(100);
  const authored = view.createEntity('IfcWall', ['0GUID000000000000000101', null, 'Authored wall', null, null, null, 13, null, null]);
  const layer = view.createEntity('IfcPresentationLayerAssignment', ['Authored layer', null, [23], null]);
  view.deleteEntity(4);
  view.deleteEntity(2);
  view.setAttribute(1, 'Name', 'Edited assembly');
  const nodes = buildPresentationLayerTree(new Map(), store, ALL, new Set([3]), new Set(['legacy']),
    id => id === '__legacy__' ? view : undefined);
  const added = nodes.find(row => row.entityExpressId === layer.expressId);
  assert.ok(added);
  assert.deepEqual(added.memberGlobalIds, [authored.expressId]);
  assert.deepEqual(added.globalIds, []);
  assert.equal(nodes.find(row => row.type === 'element' && row.expressIds[0] === authored.expressId)?.name, 'Authored wall');
  assert.equal(nodes.find(row => row.type === 'element' && row.expressIds[0] === authored.expressId)?.noGeometry, true);
  assert.equal(nodes.some(row => row.type === 'element' && [2, 4].includes(row.expressIds[0])), false);
  assert.equal(nodes.find(row => row.type === 'element' && row.expressIds[0] === 1)?.name, 'Edited assembly');
});


test('#7619 curve-only annotation layers retain overlay owner IDs for hide/show after geometry completes', async () => {
  const annotationIfc = IFC.replace(
    "#4=IFCWALL('0GUID000000000000000004',$,'Without mesh',$,$,$,#13,$,$);",
    "#4=IFCANNOTATION('0GUID000000000000000004',$,'Curve annotation',$,$,$,#13);",
  ).replace("#23=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#33));",
    "#23=IFCSHAPEREPRESENTATION($,'Annotation','Curve2D',(#33));")
    .replace('#33=IFCEXTRUDEDAREASOLID($,$,$,1.);',
      '#33=IFCPOLYLINE((#34,#35));\n#34=IFCCARTESIANPOINT((0.,0.));\n#35=IFCCARTESIANPOINT((1.,1.));');
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(annotationIfc).buffer,
    { disableWorkerScan: true });
  const models = new Map<string, FederatedModel>();
  const meshIds = new Set<number>();
  const overlayIds = collectAnnotationEntityIds(models, store);
  assert.deepEqual([...overlayIds], [4], 'annotation owner is included despite having no mesh');
  const nodes = buildTreeForGrouping('presentation-layers', models, store, ALL, false, [], 'elevation-desc',
    meshIds, new Set([...meshIds, ...overlayIds]), [], 'all', new Set(['legacy']), new Map(), new Map(), undefined, buildPresentationLayerTree);
  const header = nodes.find(row => row.entityExpressId === 52);
  assert.ok(header);
  assert.deepEqual(header.globalIds, [4], 'layer visibility targets the owner consumed by symbolic overlay hiding');
  assert.deepEqual(header.memberGlobalIds, [4]);
  assert.equal(header.noGeometry, false, 'curve geometry must keep layer visibility controls usable');
  const annotation = nodes.find(row => row.type === 'element' && row.expressIds[0] === 4);
  assert.ok(annotation);
  assert.equal(annotation.noGeometry, false);
});

test('#9272 optional layer grouping preserves flat rows, counts and exact selection/geometry membership', async () => {
  const content = IFC.replace('ENDSEC;\nEND-ISO', `
#5=IFCDOOR('0GUID000000000000000005',$,'Door',$,$,$,#14,$,$,$,$,$,$);
#14=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#24=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#34));
#34=IFCEXTRUDEDAREASOLID($,$,$,1.);
#54=IFCPRESENTATIONLAYERASSIGNMENT('Mixed',$,(#21,#24,#23),$);
#60=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#61=IFCCLASSIFICATIONREFERENCE($,'EF_25','Walls',#60,$,$);
#62=IFCRELASSOCIATESCLASSIFICATION('0GUID000000000000000062',$,$,$,(#2),#61);
ENDSEC;\nEND-ISO`);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer);
  const build = (mode?: 'none' | 'class' | 'classification') => buildPresentationLayerTree(
    new Map(), store, ALL, new Set([2, 3, 5]), new Set(['legacy']), undefined, mode);
  assert.deepEqual(build(), build('none'), 'none is byte-for-byte the existing flat row projection');
  assert.equal(build().some(row => row.type === 'type-group'), false);
  const flatLayer = build().find(row => row.entityExpressId === 54)!;
  assert.equal(flatLayer.elementCount, 3);
  assert.deepEqual(build().filter(row => row.id.startsWith(`${flatLayer.id}-product-`))
    .map(row => [row.expressIds[0], row.name, row.ifcType, row.depth]), [
      [5, 'Door', 'IfcDoor', 1], [2, 'Wall', 'IfcWall', 1], [4, 'Without mesh', 'IfcWall', 1],
    ], 'flat mode retains every expected element in its original name order');
  for (const mode of ['class', 'classification'] as const) {
    const nodes = build(mode);
    const mixed = nodes.find(row => row.entityExpressId === 54)!;
    assert.equal(mixed.elementCount, 3);
    const groups = nodes.filter(row => row.type === 'type-group' && row.id.startsWith(mixed.id));
    assert.equal(groups.length, 2);
    assert.deepEqual(groups.map(row => row.elementCount).sort(), [1, 2]);
    const wall = groups.find(row => row.name === (mode === 'class' ? 'IfcWall' : 'Uniclass: EF_25'))!;
    assert.ok(wall);
    assert.deepEqual(wall.globalIds, [2], 'non-geometric members are selectable but never visibility targets');
    assert.deepEqual(new Set(wall.memberGlobalIds), new Set(mode === 'class' ? [4, 2] : [2]));
    const selected = hierarchyRowSelection(wall, new Map(), id => ({ modelId: 'legacy', expressId: id }));
    assert.deepEqual(selected.map(item => item.globalId), wall.memberGlobalIds);
    const unclassified = groups.find(row => row.name === 'Unclassified');
    if (mode === 'classification') {
      assert.ok(unclassified);
      assert.deepEqual(new Set(unclassified.memberGlobalIds), new Set([4, 5]));
      assert.deepEqual(unclassified.globalIds, [5]);
    }
    for (const group of groups) assert.equal(nodes.filter(row => row.id.startsWith(`${group.id}-product-`)).length, group.elementCount);
  }
});

test('#9272 large mixed-layer fixture keeps every member across classification groups', async (t) => {
  // Generated STEP stress fixture: 12,000 products, shared representations and
  // four overlapping layers. No mesh generation is needed for a metadata tree.
  const count = 12_000;
  const rows = Array.from({ length: count }, (_, index) => {
    const id = 1000 + index;
    return `#${id}=${index % 2 ? 'IFCDOOR' : 'IFCWALL'}('guid${id}',$,'Element ${id}',$,$,$,#11,$);`;
  });
  const productIds = Array.from({ length: count }, (_, index) => 1000 + index);
  const content = IFC.replace('ENDSEC;\nEND-ISO', `${rows.join('\n')}
#63=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#64=IFCCLASSIFICATIONREFERENCE($,'EF_25','Walls',#63,$,$);
#65=IFCRELASSOCIATESCLASSIFICATION('stress',$,$,$,(${productIds.filter(id => id % 2 === 0).map(id => `#${id}`).join(',')}),#64);
#66=IFCPRESENTATIONLAYERASSIGNMENT('Stress A',$,(#21),$);
#67=IFCPRESENTATIONLAYERASSIGNMENT('Stress B',$,(#21),$);
ENDSEC;\nEND-ISO`);
  const store = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer);
  for (const mode of ['none', 'class', 'classification'] as const) {
    const nodes = buildPresentationLayerTree(new Map(), store, ALL, new Set(), new Set(), undefined, mode);
    const layer = nodes.find(row => row.entityExpressId === 66)!;
    assert.equal(layer.elementCount, count + 1); // original wall #2 shares #21
    const children = nodes.filter(row => row.id.startsWith(`${layer.id}-group-`) && row.type === 'type-group');
    if (mode !== 'none') {
      assert.equal(children.length, 2);
      assert.equal(children.reduce((sum, row) => sum + row.elementCount!, 0), count + 1);
    }
    t.diagnostic(`${mode}: ${count} generated products, ${nodes.length} rows; membership complete`);
  }
});

for (const mode of ['class', 'classification'] as const) {
  test(`#9272 shared IFCX ${mode} groups retain every owner and aligned member selection`, async () => {
    const store = await parse();
    const owners = ['presentation-shared-overlay', 'presentation-shared-base'];
    const { models } = fixtureModels(...owners.map(id => sharedModel(id, store)));
    const nodes = buildPresentationLayerTree(models, null, ALL, new Set([2, 3]), new Set([owners[1]]), undefined, mode);
    const groups = nodes.filter(row => row.type === 'type-group');
    assert.ok(groups.length > 0);
    for (const group of groups) {
      assert.deepEqual(group.modelIds, owners, 'badges retain both shared-store owners');
      assert.equal(group.modelId, undefined, 'shared groups never invent single-owner attribution');
      const selection = hierarchyRowSelection(group, models, () => null);
      assert.deepEqual(selection.map(row => row.expressId), group.expressIds);
      assert.deepEqual(selection.map(row => row.modelId), group.expressIds.map(() => owners[0]),
        'every member resolves through the same representative as the layer, regardless of group size');
    }
  });
}

const classificationIfc = (extra: string) => IFC.replace('ENDSEC;\nEND-ISO', `
#60=IFCCLASSIFICATION($,$,$,'Uniclass',$,$,$);
#61=IFCCLASSIFICATIONREFERENCE($,'EF_25','Walls',#60,$,$);
${extra}
ENDSEC;\nEND-ISO`);
const parseClassification = (extra: string) => new IfcParser().parseColumnar(
  new TextEncoder().encode(classificationIfc(extra)).buffer, { disableWorkerScan: true });

test('#9383 source-empty classified members have a distinct unavailable bucket', async () => {
  const store = await parseClassification("#62=IFCRELASSOCIATESCLASSIFICATION('rel',$,$,$,(#2),#61);");
  const transport = { ...store, source: new Uint8Array() };
  const view = new MutablePropertyView(null, '__legacy__');
  view.setExpressIdWatermark(100);
  // Native metadata-only inputs can still have live authored geometry/layers.
  view.setAttribute(2, 'Representation', '#11');
  view.setAttribute(11, 'Representations', '(#21)');
  const unclassified = view.createEntity('IfcWall', ['new', null, 'Unclassified wall', null, null, null, 11, null, null]);
  const layer = view.createEntity('IfcPresentationLayerAssignment', ['Transport layer', null, [21], null]);
  const rows = buildPresentationLayerTree(new Map(), transport, ALL, new Set([2]), new Set(['legacy']),
    () => view, 'classification', 'Unclassified', 'Classification unavailable');
  const header = rows.find(row => row.entityExpressId === layer.expressId);
  assert.ok(header);
  const groups = rows.filter(row => row.type === 'type-group' && row.id.startsWith(header.id));
  assert.deepEqual(groups.find(row => row.name === 'Classification unavailable')?.memberGlobalIds, [2]);
  assert.deepEqual(groups.find(row => row.name === 'Unclassified')?.memberGlobalIds, [unclassified.expressId]);
});

test('#9383 direct classification uses the system name once', async () => {
  const store = await parseClassification("#62=IFCRELASSOCIATESCLASSIFICATION('rel',$,$,$,(#2),#60);");
  const rows = buildPresentationLayerTree(new Map(), store, ALL, new Set([2]), new Set(['legacy']), undefined, 'classification');
  const group = rows.find(row => row.type === 'type-group' && row.name === 'Uniclass');
  assert.ok(group);
  assert.deepEqual(group.memberGlobalIds, [2]);
  assert.equal(rows.some(row => row.name === 'Uniclass: Uniclass'), false);
});

test('#9383 direct and type-level references populate both groups with exact deduplicated counts', async () => {
  const store = await parseClassification(`
#62=IFCCLASSIFICATIONREFERENCE($,'EF_30','Type class',#60,$,$);
#70=IFCWALLTYPE('type',$,'Wall type',$,$,$,$,$,$,.NOTDEFINED.);
#71=IFCRELASSOCIATESCLASSIFICATION('direct',$,$,$,(#2),#61);
#72=IFCRELASSOCIATESCLASSIFICATION('typeclass',$,$,$,(#70),#62);
#73=IFCRELDEFINESBYTYPE('types',$,$,$,(#2,#4),#70);
#74=IFCRELASSOCIATESCLASSIFICATION('duplicate',$,$,$,(#2),#62);
#54=IFCPRESENTATIONLAYERASSIGNMENT('Mixed',$,(#21,#23),$);`);
  const rows = buildPresentationLayerTree(new Map(), store, ALL, new Set([2]), new Set(['legacy']), undefined, 'classification');
  const header = rows.find(row => row.entityExpressId === 54);
  assert.ok(header);
  const groups = rows.filter(row => row.type === 'type-group' && row.id.startsWith(header.id));
  assert.equal(groups.length, 2);
  for (const [name, ids] of [['Uniclass: EF_25', [2]], ['Uniclass: EF_30', [2, 4]]] as const) {
    const group = groups.find(row => row.name === name);
    assert.ok(group);
    assert.equal(group.elementCount, ids.length);
    assert.deepEqual(group.memberGlobalIds, [...ids]);
    assert.deepEqual(rows.filter(row => row.id.startsWith(`${group.id}-product-`)).map(row => row.expressIds[0]), [...ids]);
  }
});

test('#9383 shared reference decodes once and edits invalidate it without sharing mutable results', async () => {
  const store = await parseClassification("#62=IFCRELASSOCIATESCLASSIFICATION('rel',$,$,$,(#2,#4),#61);");
  const original = store.getEntity.bind(store);
  let reads = 0;
  store.getEntity = id => { if (id === 61) reads++; return original(id); };
  const first = extractClassificationsOnDemand(store, 2);
  first[0].identification = 'Caller edit';
  first[0].path?.push('Caller path edit');
  const next = extractClassificationsOnDemand(store, 4);
  assert.equal(next[0].identification, 'EF_25', 'callers cannot corrupt a shared cached reference');
  assert.deepEqual(next[0].path, [], 'path arrays are independent too');
  assert.equal(reads, 1, 'shared references decode once instead of once per product');
  assert.ok(store.source instanceof Uint8Array);
  store.source = store.source.slice();
  assert.equal(extractClassificationsOnDemand(store, 2)[0].identification, 'EF_25');
  assert.equal(reads, 2, 'source replacement invalidates the reference memo');
  const view = new MutablePropertyView(null, '__legacy__');
  assert.equal(extractClassificationsOnDemand(store, 2, view)[0].identification, 'EF_25');
  view.setAttribute(61, 'Identification', 'EF_30');
  assert.equal(extractClassificationsOnDemand(store, 4, view)[0].identification, 'EF_30');
  view.setAttribute(60, 'Name', 'Changed system');
  assert.equal(extractClassificationsOnDemand(store, 2, view)[0].system, 'Changed system');
});
