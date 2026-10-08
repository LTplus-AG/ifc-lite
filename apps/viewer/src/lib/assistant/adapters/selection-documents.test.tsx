/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractDocumentsOnDemand, EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { parseStep, seedModel, exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { render, advance, cleanup, click } from '@/test/render';
import { entityRefToString } from '@/store/entity-ref';
import { useViewerStore } from '@/store';
import { captureEvidence } from '../evidence';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
interface Document { expressId: number; verification: string; type: string; Name: string | null;
  Identification?: string; Location: string | null; Revision?: string }
interface Row { modelId: string; documentStatus: string; documentCount: number | null; documents: Document[] }
const rows = (): Row[] => JSON.parse(captureEvidence('selection').payload).evidence.rows.map((row: { data: Row }) => row.data);

/** Authored metadata is an explicit native writer addition to real SketchUp. */
async function fixture() {
  const store = await parseStep(await readFile(new URL('../../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8'));
  seedModel('native', 0, store, 52);
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view); view.setExpressIdWatermark(100_000);
  const info = view.createEntity('IfcDocumentInformation', ['SPEC-001', 'Roof specification', 'Native specification description',
    'https://example.test/spec.pdf', 'Roof acceptance', 'Coordination', null, 'R1']);
  const reference = view.createEntity('IfcDocumentReference', ['https://example.test/roof-ref.pdf', 'REF-001', 'Native roof document',
    'Native reference description', `#${info.expressId}`]);
  const relationship = view.createEntity('IfcRelAssociatesDocument', ['0000000000000000000001', null, null, null, ['#52'], `#${reference.expressId}`]);
  const file = await exportAndReparse('native', store);
  assert.equal(file.getEntity(relationship.expressId)?.attributes[5], reference.expressId);
  assert.equal(file.getEntity(reference.expressId)?.attributes[4], info.expressId);
  const native = extractDocumentsOnDemand(file, 52);
  assert.equal(native[0]?.location, 'https://example.test/roof-ref.pdf'); assert.equal(native[0].revision, 'R1');
  useViewerStore.setState({ mutationViews: new Map(), selectedEntitiesSet: new Set(), selectedEntities: [] });
  seedModel('native', 0, file, 52);
  return { file, referenceId: reference.expressId, relationshipId: relationship.expressId, infoId: info.expressId };
}

// #7187 existing native Properties has these values; edge Name/type alone is insufficient.
test('#7187 selected document metadata agrees with native exported reader and Properties', async () => {
  const { referenceId } = await fixture();
  const ui = render(renderPanelBody('properties', () => undefined)); await advance(0);
  const trigger = [...ui.querySelectorAll('button')].find(button => button.textContent?.includes('Native roof document')); assert.ok(trigger);
  if (!ui.textContent?.includes('Roof acceptance')) { click(trigger); await advance(0); }
  assert.match(ui.textContent ?? '', /Roof acceptance/); assert.match(ui.textContent ?? '', /https:\/\/example.test\/roof-ref.pdf/);
  const row = rows()[0]; assert.equal(row.documentStatus, 'available'); assert.equal(row.documentCount, 1);
  assert.deepEqual(row.documents.map(doc => [doc.expressId, doc.type, doc.Name, doc.Identification, doc.Location, doc.Revision]),
    [[referenceId, 'IfcDocumentReference', 'Native roof document', 'REF-001', 'https://example.test/roof-ref.pdf', 'R1']]);
});

// #7187 the public STEP writer is the oracle for unsaved source document edits.
test('#7187 native document SDK and selected metadata reflect source field edits with positional precedence', async () => {
  const { file, referenceId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setAttribute(referenceId, 'Location', 'https://example.test/current.pdf');
  view.setAttribute(referenceId, 'Name', 'Named value'); view.setPositionalAttribute(referenceId, 2, 'Positional value');
  const exported = await exportAndReparse('native', file);
  const saved = extractDocumentsOnDemand(exported, 52);
  assert.equal(saved[0].name, 'Positional value'); assert.equal(saved[0].location, 'https://example.test/current.pdf');
  const current = createQueryAdapter(useViewerStore).documents({ modelId: 'native', expressId: 52 });
  assert.equal(current[0]?.name, 'Positional value'); assert.equal(current[0].location, saved[0].location);
  const row = rows()[0]; assert.equal(row.documents[0].Name, 'Positional value'); assert.equal(row.documents[0].Location, saved[0].location);
});

// #7187 source reference membership changes in the actual native saved graph.
test('#7187 source document reassignment and deletion agree with native export', async () => {
  const { file, relationshipId } = await fixture();
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setPositionalAttribute(relationshipId, 4, ['#89']);
  const moved = await exportAndReparse('native', file);
  assert.equal(extractDocumentsOnDemand(moved, 52).length, 0); assert.equal(extractDocumentsOnDemand(moved, 89).length, 1);
  const beforeDeletion = createQueryAdapter(useViewerStore).documents({ modelId: 'native', expressId: 52 });
  view.deleteEntity(relationshipId);
  const removed = await exportAndReparse('native', file); assert.equal(removed.entityIndex.byId.has(relationshipId), false);
  assert.equal(extractDocumentsOnDemand(removed, 89).length, 0);
  assert.equal(beforeDeletion.length, 0); assert.equal(rows()[0].documentCount, 0);
});

// #7187 a forwarded source relationship is known, but its absent leaf fields are not.
test('#7187 source-free original and edited document membership remain explicitly unknown', async () => {
  const { file, referenceId, relationshipId } = await fixture();
  file.source = EMPTY_SOURCE_BYTES;
  const view = getOrCreateMutationView(useViewerStore, 'native'); assert.ok(view);
  view.setPositionalAttribute(relationshipId, 4, ['#89']);
  const row = rows()[0]; assert.equal(row.documentCount, null);
  assert.equal(row.documentStatus, 'unavailable-source-membership');
  assert.ok(row.documents.some(doc => doc.expressId === referenceId && doc.verification === 'unverified' && doc.Name === null && doc.Location === null));
});

// #7187 two independent parsed stores can use the same native document IDs.
test('#7187 native document field edits remain isolated across one and multiple models', async () => {
  const first = await fixture(); const a = useViewerStore.getState().models.get('native'); assert.ok(a);
  const second = await fixture(); const b = useViewerStore.getState().models.get('native'); assert.ok(b);
  useViewerStore.setState({ models: new Map([['a', { ...a, id: 'a', name: 'a', ifcDataStore: first.file }],
    ['b', { ...b, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: second.file }]]), mutationViews: new Map() });
  const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view); view.setAttribute(second.referenceId, 'Name', 'B ONLY');
  const exported = await exportAndReparse('b', second.file); assert.equal(extractDocumentsOnDemand(exported, 52)[0].name, 'B ONLY');
  assert.equal(createQueryAdapter(useViewerStore).documents({ modelId: 'a', expressId: 52 })[0].name, 'Native roof document');
  assert.equal(createQueryAdapter(useViewerStore).documents({ modelId: 'b', expressId: 52 })[0].name, 'B ONLY');
  useViewerStore.setState({ selectedEntitiesSet: new Set(['a', 'b'].map(modelId => entityRefToString({ modelId, expressId: 52 }))) });
  const captured = rows(); assert.equal(captured.length, 2);
  assert.deepEqual(captured.map(row => [row.modelId, row.documents[0].Name]), [['a', 'Native roof document'], ['b', 'B ONLY']]);
});
