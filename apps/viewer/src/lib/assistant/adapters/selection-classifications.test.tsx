/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES, extractClassificationsOnDemand } from '@ifc-lite/parser';
import { advance, render, cleanup } from '@/test/render';
import { exportAndReparse, parseStep, seedModel } from '@/test/properties-panel-harness';
import { exportChangedModelToStep } from '@/lib/export/changed-model-export';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { entityRefToString } from '@/store/entity-ref';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
interface Classification { Name: string | null; Identification?: string | null; ItemReference?: string | null;
  system: { Name: string } | null; verification: string; pathCount: number | null; path: string[] }
interface Row { modelId: string; classificationStatus: string; classificationCount: number | null;
  classifications: Classification[] }
const rows = (): Row[] => JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Row }) => row.data);

// #7139 authored source: #21173 links real space #20909 to #21169.
// The reference's ReferencedSource is $, so its relationship Name is not a system.
test('#7139 actual ArchiCAD classification agrees with the native panel without inventing a system', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const store = await parseStep(bytes);
  const native = extractClassificationsOnDemand(store, 20909);
  assert.equal(native[0].identification, '000'); assert.equal(native[0].name, 'Allgemeines');
  assert.equal(native[0].system, undefined);
  seedModel('archicad', 0, store, 20909);
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  assert.match(ui.textContent ?? '', /Allgemeines/); cleanup();
  const row = rows()[0];
  assert.equal(row.modelId, 'archicad'); assert.equal(row.classificationStatus, 'available');
  assert.equal(row.classificationCount, 1);
  assert.deepEqual(row.classifications.map(reference => [reference.Identification, reference.Name, reference.system, reference.verification]),
    [['000', 'Allgemeines', null, 'resolved']]);
});

// #7139 public authoring markers over the actual SketchUp slab/type graph.
// STEP export/reparse establishes the native IFC values independently of evidence.
test('#7139 authored occurrence and type classifications preserve native export values', async () => {
  const source = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const store = await parseStep(source); seedModel('sketchup', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'sketchup'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const system = view.createEntity('IfcClassification', ['Public writer', '2026', null, 'Native classification system', null, null, null]);
  const occurrence = view.createEntity('IfcClassificationReference', ['https://example.test/occurrence', 'O-52', 'Occurrence classification', `#${system.expressId}`, 'Occurrence description', null]);
  const type = view.createEntity('IfcClassificationReference', [null, 'T-50', 'Type classification', `#${system.expressId}`, null, null]);
  view.createEntity('IfcRelAssociatesClassification', ['0000000000000000000001', null, null, null, ['#52'], `#${occurrence.expressId}`]);
  view.createEntity('IfcRelAssociatesClassification', ['0000000000000000000002', null, null, null, ['#50'], `#${type.expressId}`]);
  const file = await exportAndReparse('sketchup', store);
  const native = extractClassificationsOnDemand(file, 52);
  assert.deepEqual(native.map(reference => reference.identification).sort(), ['O-52', 'T-50']);
  assert.ok(native.every(reference => reference.system === 'Native classification system'));
  assert.deepEqual(native.map(reference => reference.name).sort(), ['Occurrence classification', 'Type classification']);
  // The adapter must read the same effective native authoring graph before export.
  const row = rows()[0];
  assert.equal(row.classificationCount, 2);
  assert.deepEqual(row.classifications.map(reference => reference.Identification).sort(), ['O-52', 'T-50']);
});

// #7139 model-local reference IDs collide in federation; edits must remain in B.
test('#7139 independent federation preserves model-local authored classification edits', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const a = await parseStep(bytes), b = await parseStep(bytes);
  seedModel('a', 0, a, 20909); const first = useViewerStore.getState().models.get('a'); assert.ok(first);
  useViewerStore.setState({ models: new Map([['a', first], ['b', { ...first, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: b }]]) });
  const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view);
  view.setAttribute(21169, 'Name', 'B ONLY');
  useViewerStore.setState({ selectedEntitiesSet: new Set(['a', 'b'].map(modelId => entityRefToString({ modelId, expressId: 20909 }))) });
  const file = await exportAndReparse('b', b);
  assert.equal(extractClassificationsOnDemand(file, 20909)[0].name, 'B ONLY');
  const selected = rows();
  assert.ok(selected.every(row => Array.isArray(row.classifications)), 'each selected model must carry native classification evidence');
  assert.deepEqual(selected.map(row => [row.modelId, row.classifications[0].Name]), [['a', 'Allgemeines'], ['b', 'B ONLY']]);
});

// #7139 effective source edits follow the same positional precedence as STEP export;
// deleting the actual source association changes membership, rather than only labels.
test('#7139 current source classification fields and removed membership agree with native export', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const store = await parseStep(bytes); seedModel('edited', 0, store, 20909);
  const view = getOrCreateMutationView(useViewerStore, 'edited'); assert.ok(view);
  view.setAttribute(21169, 'Name', 'Named value');
  view.setPositionalAttribute(21169, 2, 'Positional value');
  const file = await exportAndReparse('edited', store);
  assert.equal(extractClassificationsOnDemand(file, 20909)[0].name, 'Positional value');
  const editedEvidence = rows()[0];
  view.deleteEntity(21173);
  const removed = await exportAndReparse('edited', store);
  assert.deepEqual(extractClassificationsOnDemand(removed, 20909), []);
  assert.ok(Array.isArray(editedEvidence.classifications), 'edited source classification must be included');
  assert.equal(editedEvidence.classifications[0].Name, 'Positional value');
  assert.equal(rows()[0].classificationCount, 0);
  assert.deepEqual(rows()[0].classifications, []);
});

// #7139 no bytes means edited source membership cannot prove an empty/full count.
test('#7139 source-empty edited classification membership remains explicitly unavailable', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const store = await parseStep(bytes); store.source = EMPTY_SOURCE_BYTES;
  seedModel('wire', 0, store, 20909);
  assert.ok(extractClassificationsOnDemand(store, 20909).some(reference => reference.unresolved));
  const original = rows()[0];
  const view = getOrCreateMutationView(useViewerStore, 'wire'); assert.ok(view);
  view.setPositionalAttribute(21173, 4, ['#20909']);
  const row = rows()[0];
  assert.equal(row.classificationStatus, 'unavailable-source-membership');
  assert.equal(row.classificationCount, null);
  assert.ok(row.classifications.some(reference => reference.verification === 'unverified'));
  assert.equal(original.classificationStatus, 'available');
  assert.equal(original.classificationCount, 1);
  assert.deepEqual(original.classifications.map(reference => [reference.Name, reference.system, reference.verification]),
    [[null, null, 'unverified']]);
});

// #7139 stated transport omission: absence of both native membership inventories
// cannot establish that the known ArchiCAD space has no classifications.
test('#7139 source-empty transport missing classification inventories has an unknown total', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const source = await parseStep(bytes);
  assert.equal(extractClassificationsOnDemand(source, 20909).length, 1);
  const wire = { ...source, source: EMPTY_SOURCE_BYTES, resolvedClassifications: undefined };
  Reflect.deleteProperty(wire, 'relationships'); Reflect.deleteProperty(wire, 'onDemandClassificationMap');
  seedModel('missing-graph', 0, wire, 20909);
  const row = rows()[0];
  assert.equal(row.classificationStatus, 'unavailable-membership');
  assert.equal(row.classificationCount, null);
  assert.deepEqual(row.classifications, []);
});

// #7139 graph-proved assignments to absent/wrong-type records are unreadable,
// rather than evidence that the selected occurrence is unclassified.
test('#7139 unreadable classification targets preserve known association counts', async t => {
  const fixture = new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch AC20-FZK-Haus.ifc'); return; }
    throw error;
  }
  const source = await parseStep(bytes); seedModel('broken-target', 0, source, 20909);
  const view = getOrCreateMutationView(useViewerStore, 'broken-target'); assert.ok(view);
  const readbacks: Row[] = [];
  for (const targetId of [999999, 20909]) {
    view.setPositionalAttribute(21173, 5, `#${targetId}`);
    const file = await exportAndReparse('broken-target', source);
    assert.deepEqual(file.onDemandClassificationMap?.get(20909), [targetId]);
    if (targetId === 999999) assert.equal(file.entityIndex.byId.has(targetId), false);
    else assert.equal(file.entities.getTypeName(targetId), 'IfcSpace');
    seedModel(`readback-${targetId}`, 0, file, 20909);
    readbacks.push(rows()[0]);
  }
  for (const row of readbacks) {
    assert.equal(row.classificationCount, 1);
    assert.deepEqual(row.classifications.map(reference => [reference.Name, reference.system, reference.verification]),
      [[null, null, 'unverified']]);
  }
});

// #7139 full counts and bounded text/rows are measured on real public authored references.
test('#7139 authored classification fan-out is sampled with full known counts', async () => {
  const source = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const store = await parseStep(source); seedModel('bounded', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'bounded'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const system = view.createEntity('IfcClassification', ['Public writer', null, null, 'System', null, null, null]);
  for (let i = 0; i < 20; i++) {
    const reference = view.createEntity('IfcClassificationReference', [null, `Reference ${i}`, i ? `Name ${i}` : 'x'.repeat(251), `#${system.expressId}`, null, null]);
    view.createEntity('IfcRelAssociatesClassification', [`0${String(i).padStart(21, '0')}`, null, null, null, ['#52'], `#${reference.expressId}`]);
  }
  const file = await exportAndReparse('bounded', store);
  assert.equal(extractClassificationsOnDemand(file, 52).length, 20);
  const row = rows()[0];
  assert.equal(row.classificationCount, 20); assert.equal(row.classifications.length, 16);
  assert.equal(row.classifications[0].Name?.length, 241);
});

// #7139 the native reference chain supplies the path; its evidence sample has
// an explicit full count, rather than silently dropping distant ancestors.
test('#7139 authored classification paths retain native order and bounded ancestry', async () => {
  const source = await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
  const store = await parseStep(source); seedModel('path', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'path'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const system = view.createEntity('IfcClassification', ['Public writer', null, null, 'Path system', null, null, null]);
  let parentId = system.expressId;
  for (let i = 0; i < 21; i++) {
    parentId = view.createEntity('IfcClassificationReference', [null, `Level ${i}`, `Name ${i}`, `#${parentId}`, null, null]).expressId;
  }
  view.createEntity('IfcRelAssociatesClassification', ['0000000000000000000001', null, null, null, ['#52'], `#${parentId}`]);
  const file = await exportAndReparse('path', store);
  const native = extractClassificationsOnDemand(file, 52)[0];
  assert.equal(native.system, 'Path system');
  assert.deepEqual(native.path, Array.from({ length: 20 }, (_, i) => `Level ${i}`));
  const row = rows()[0];
  assert.ok(Array.isArray(row.classifications), 'native classification path must be included');
  assert.equal(row.classifications[0].pathCount, 20);
  assert.deepEqual(row.classifications[0].path, native.path.slice(0, 16));
});

// #7139 native conversion of a real Revit wall preserves the IFC2X3 reference spelling.
test('#7139 converted Revit fixture uses exact IFC2X3 reference attribute names', async t => {
  const fixture = new URL('../../../../../../tests/models/various/revit-walls-3.ifc', import.meta.url);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(fixture)); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures to fetch revit-walls-3.ifc'); return; }
    throw error;
  }
  const store = await parseStep(bytes); seedModel('conversion', 0, store, 139);
  const view = getOrCreateMutationView(useViewerStore, 'conversion'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const system = view.createEntity('IfcClassification', ['Public writer', null, null, 'System', null, null, null]);
  const reference = view.createEntity('IfcClassificationReference', [null, 'Converted reference', 'Converted name', `#${system.expressId}`, null, null]);
  view.createEntity('IfcRelAssociatesClassification', ['0000000000000000000001', null, null, null, ['#139'], `#${reference.expressId}`]);
  const artifact = await exportChangedModelToStep('conversion', store, view, {
    schema: 'IFC2X3', scheduleState: null, description: 'ViewDefinition [CoordinationView]',
  });
  const file = await parseStep(artifact.content);
  assert.equal(file.schemaVersion, 'IFC2X3');
  assert.equal(extractClassificationsOnDemand(file, 139)[0].identification, 'Converted reference');
  seedModel('converted', 0, file, 139);
  const row = rows()[0];
  assert.ok(Array.isArray(row.classifications), 'converted model must carry native classification evidence');
  assert.equal(row.classifications[0].ItemReference, 'Converted reference');
  assert.equal(row.classifications[0].Identification, undefined);
});
