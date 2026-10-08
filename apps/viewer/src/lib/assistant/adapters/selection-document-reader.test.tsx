/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RelationshipType } from '@ifc-lite/data';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { extractDocumentsOnDemand as documents } from '../../../../../../packages/parser/src/document-resolver.js';
import { parseStep, seedModel, exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { useViewerStore } from '@/store';
import { documentPopulationUnavailable } from '@/components/viewer/properties/effective-document-availability';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
async function fixture() {
  const file = await parseStep(await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
  seedModel('native', 0, file, 52);
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(100_000);
  // Authored additions to a real SketchUp export, using the public reference contract.
  const info = view.createEntity('IfcDocumentInformation', ['SPEC-001', 'Specification', null, 'info.pdf', 'Acceptance', 'Coordination', null, 'R1']);
  const reference = view.createEntity('IfcDocumentReference', ['ref.pdf', 'REF-001', 'Reference', 'Description', `#${info.expressId}`]);
  const relation = view.createEntity('IfcRelAssociatesDocument', ['0000000000000000000001', null, null, null, ['#52'], `#${reference.expressId}`]);
  return { file, view, infoId: info.expressId, referenceId: reference.expressId, relationshipId: relation.expressId };
}

// #7187 the implementation reader is checked against actual public export/reparse,
// independently of currently built workspace declaration/runtime artifacts.
test('#7187 canonical native authored document fields and source edits match saved IFC', async () => {
  const { file, view, referenceId } = await fixture();
  const authored = documents(file, 52, view); assert.equal(authored[0].revision, 'R1');
  const source = await exportAndReparse('native', file);
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, source, 52);
  const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits);
  edits.setAttribute(referenceId, 'Name', 'Named'); edits.setPositionalAttribute(referenceId, 2, 'Positional');
  edits.setAttribute(referenceId, 'Location', 'current.pdf');
  const saved = await exportAndReparse('native', source);
  assert.equal(documents(saved, 52)[0].name, 'Positional');
  assert.deepEqual(documents(source, 52, edits), documents(saved, 52));
});

test('#7187 canonical native document membership retarget and deletion match saved IFC', async () => {
  const { file, view, relationshipId } = await fixture();
  const source = await exportAndReparse('native', file);
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, source, 52);
  const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits);
  edits.setPositionalAttribute(relationshipId, 4, ['#89']);
  const saved = await exportAndReparse('native', source);
  assert.equal(documents(saved, 52).length, 0); assert.equal(documents(saved, 89).length, 1);
  assert.deepEqual(documents(source, 52, edits), documents(saved, 52));
  assert.deepEqual(documents(source, 89, edits), documents(saved, 89));
  edits.deleteEntity(relationshipId);
  const deleted = await exportAndReparse('native', source);
  assert.equal(deleted.entityIndex.byId.has(relationshipId), false);
  assert.deepEqual(documents(source, 89, edits), documents(deleted, 89));
  assert.equal(view.getNewEntity(relationshipId)?.type, 'IfcRelAssociatesDocument');
});

test('#7187 source-free native authored documents are available and original leaves are unverified', async () => {
  const { file, view, referenceId } = await fixture();
  const saved = await exportAndReparse('native', file);
  file.source = EMPTY_SOURCE_BYTES;
  const originalAccessor = file.getEntity;
  file.getEntity = () => { throw new Error('Opaque transport must not read retained source bytes'); };
  assert.equal(documents(file, 52, view)[0].location, 'ref.pdf');
  assert.equal(documentPopulationUnavailable(file, view), false);
  file.getEntity = originalAccessor;
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, saved, 52);
  saved.source = EMPTY_SOURCE_BYTES;
  saved.getEntity = () => { throw new Error('Opaque original leaf must not read retained source bytes'); };
  const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits);
  const markers = documents(saved, 52, edits);
  assert.equal(markers[0].expressId, referenceId); assert.equal(markers[0].unresolved, true);
  assert.equal(markers[0].location, undefined);
  edits.setPositionalAttribute(referenceId, 0, 'known-edited.pdf');
  assert.equal(documentPopulationUnavailable(saved, edits), true);
  assert.equal(documents(saved, 52, edits)[0].location, undefined);
});

test('#7187 document string markers preserve actual named versus positional STEP semantics', async () => {
  const { file, view, referenceId } = await fixture();
  const source = await exportAndReparse('native', file);
  for (const [slot, value] of [['named', ' $ '], ['named', '$'], ['named', '*'], ['named', ''],
    ['positional', ' $ '], ['positional', ' * ']] as const) {
    useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, source, 52);
    const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits);
    if (slot === 'named') edits.setAttribute(referenceId, 'Name', value);
    else edits.setPositionalAttribute(referenceId, 2, value);
    const saved = await exportAndReparse('native', source);
    const actual = documents(saved, 52)[0].name;
    assert.equal(actual, slot === 'named' && value === ' $ ' ? ' $ ' : value.trim() === '$' ? 'Specification' : value.trim() === '*' ? '*' : value);
    assert.equal(documents(source, 52, edits)[0].name, actual, `${slot} ${JSON.stringify(value)}`);
  }
  assert.equal(view.getNewEntity(referenceId)?.type, 'IfcDocumentReference');
});

test('#7187 source removal invalidates previously decoded leaf fields in the same native edit session', async () => {
  const { file, view, referenceId } = await fixture();
  const source = await exportAndReparse('native', file);
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, source, 52);
  const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits); edits.setExpressIdWatermark(200_000);
  const authored = edits.createEntity('IfcRelAssociatesDocument', ['0000000000000000000002', null, null, null, ['#89'], `#${referenceId}`]);
  assert.equal(documents(source, 89, edits)[0].location, 'ref.pdf');
  assert.ok(edits.getNewEntity(authored.expressId)); assert.ok(view.getNewEntity(referenceId));
  source.source = EMPTY_SOURCE_BYTES;
  source.getEntity = () => { throw new Error('Source-free session must not reveal closed-over bytes'); };
  const current = documents(source, 89, edits)[0];
  assert.equal(current.unresolved, true); assert.equal(current.location, undefined);
  assert.equal(current.name, undefined); assert.equal(current.revision, undefined);
});

test('#7187 native occurrence and inherited type documents share current memberships', async () => {
  const { file, view, referenceId, relationshipId } = await fixture();
  const type = view.createEntity('IfcSlabType', ['0000000000000000000003', null, 'Authored roof type', null, null, null, null, null, null, '.ROOF.']);
  view.createEntity('IfcRelDefinesByType', ['0000000000000000000004', null, null, null, ['#52'], `#${type.expressId}`]);
  view.setPositionalAttribute(relationshipId, 4, [`#${type.expressId}`]);
  const saved = await exportAndReparse('native', file);
  assert.equal(documents(saved, 52)[0].expressId, referenceId);
  assert.ok(saved.relationships?.getRelated(52, RelationshipType.DefinesByType, 'inverse').includes(type.expressId));
  assert.deepEqual(documents(file, 52, view), documents(saved, 52));
  const extra = view.createEntity('IfcDocumentReference', ['occurrence.pdf', 'OCC', 'Occurrence document', null, null]);
  view.createEntity('IfcRelAssociatesDocument', ['0000000000000000000005', null, null, null, ['#52'], `#${extra.expressId}`]);
  const both = await exportAndReparse('native', file);
  assert.deepEqual(new Set(documents(file, 52, view).map(row => row.expressId)), new Set(documents(both, 52).map(row => row.expressId)));
  assert.equal(documents(both, 52).length, 2);
});

test('#7187 known native associations retain unresolved wrong/missing document targets', async () => {
  const { file, view, relationshipId } = await fixture();
  for (const target of [999999, 89]) {
    view.setPositionalAttribute(relationshipId, 5, `#${target}`);
    const saved = await exportAndReparse('native', file);
    assert.equal(saved.getEntity(relationshipId)?.attributes[5], target);
    assert.equal(documents(saved, 52)[0].expressId, target);
    assert.equal(documents(saved, 52)[0].unresolved, true);
    assert.equal(documents(saved, 52)[0].name, undefined);
    assert.deepEqual(documents(file, 52, view), documents(saved, 52));
  }
});

test('#7187 source-free sparse indexed document edits make population availability unknown', async () => {
  const { file, relationshipId } = await fixture();
  const source = await exportAndReparse('native', file);
  useViewerStore.setState({ mutationViews: new Map() }); seedModel('native', 0, source, 52);
  const edits = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(edits);
  source.source = EMPTY_SOURCE_BYTES;
  source.entities.getTypeName = () => 'Unknown';
  assert.equal(source.entityIndex.byId.get(relationshipId)?.type, 'IFCRELASSOCIATESDOCUMENT');
  edits.setPositionalAttribute(relationshipId, 4, ['#89']);
  assert.equal(documentPopulationUnavailable(source, edits), true);
});
