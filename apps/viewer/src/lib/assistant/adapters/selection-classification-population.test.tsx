/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import test, { afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_SOURCE_BYTES } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { parseStep, seedModel, exportAndReparse } from '@/test/properties-panel-harness';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { entityRefToString } from '@/store/entity-ref';
import { captureEvidence } from '../evidence';
import { selectionAdapter } from './selection';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
// #7238 independently recorded actual AC20 source#21173 RelatedObjects, not an aggregate reader result.
const SPACES = [20909, 21283, 21640, 33774, 34191, 34763, 76214];
interface Aggregate { requested: number; scanned: number; classified: number; unclassified: number; unknown: number;
  status: string; omittedLabelGroups: number; omittedModelGroups: number; referenceRows: number; models: Array<{ modelId: string; classified: number; unclassified: number; unknown: number }>;
  labels: Array<{ modelId: string; system: string | null; Identification?: string; ItemReference?: string; elements: number }> }
const aggregate = (capture: { summary: unknown }): Aggregate | undefined =>
  (capture.summary as { classifications?: Aggregate }).classifications;

async function model(t: TestContext) {
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(new URL('../../../../../../tests/models/ara3d/AC20-FZK-Haus.ifc', import.meta.url))); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { t.skip('run pnpm fixtures for AC20-FZK-Haus.ifc'); return null; }
    throw error;
  }
  const store = await parseStep(bytes);
  const association = store.getEntity(21173); assert.ok(association);
  assert.equal(association.type.toUpperCase(), 'IFCRELASSOCIATESCLASSIFICATION');
  assert.deepEqual(association.attributes[4], SPACES);
  const reference = store.getEntity(21169); assert.ok(reference);
  assert.equal(reference.attributes[1], '000'); assert.equal(reference.attributes[2], 'Allgemeines');
  assert.equal(reference.attributes[3], null, 'no native declared system to invent from relationship Name');
  // An exact user-selected IFC reference population, including non-geometric entity inspector rows.
  // The existing selection contract permits these IDs; no repeated/fabricated IDs inflate the sample.
  const context = Array.from(store.entities.expressId).filter(id => !SPACES.includes(id)).slice(0, 100);
  assert.equal(new Set(context).size, 100);
  return { store, ids: [...context, ...SPACES] };
}

for (const federated of [false, true]) test(`#7238 native ${federated ? 'N' : '1'}-model classifications beyond sampled rows have exact whole-population denominators`, async t => {
  const a = await model(t); if (!a) return;
  seedModel('a', 0, a.store, SPACES[0]);
  const refs = a.ids.map(expressId => ({ modelId: 'a', expressId }));
  if (federated) {
    const b = await model(t); assert.ok(b);
    const first = useViewerStore.getState().models.get('a'); assert.ok(first);
    useViewerStore.setState({ models: new Map([['a', first], ['b', { ...first, id: 'b', name: 'b', idOffset: 1_000_000, ifcDataStore: b.store }]]) });
    const view = getOrCreateMutationView(useViewerStore, 'b'); assert.ok(view);
    view.setPositionalAttribute(21173, 4, ['#20909']);
    // Native public writer and real reparse establish B membership independently of the evidence aggregate.
    const file = await exportAndReparse('b', b.store);
    assert.deepEqual(file.getEntity(21173)?.attributes[4], [20909]);
    refs.push(...b.ids.map(expressId => ({ modelId: 'b', expressId })));
  }
  useViewerStore.setState({ selectedEntities: [], selectedEntitiesSet: new Set(refs.map(entityRefToString)), selectedEntityIds: new Set() });
  const small = selectionAdapter.capture(useViewerStore.getState(), 1);
  assert.equal(small.rows.length, 1);
  assert.equal((small.rows[0] as { classificationCount: number }).classificationCount, 0);
  const full = captureEvidence('selection'); const payload = JSON.parse(full.payload);
  assert.ok(full.includedRows <= 100); assert.ok(full.includedRows < refs.length);
  assert.ok(payload.evidence.rows.every((row: { data: { classificationCount: number } }) => row.data.classificationCount === 0),
    'all known native memberships occur after the projected detail sample');
  const facts = aggregate(small); assert.ok(facts, 'whole-population classification facts cannot be inferred from empty sampled rows');
  assert.equal(facts.requested, refs.length); assert.equal(facts.scanned, refs.length);
  assert.equal(facts.classified, federated ? 8 : 7); assert.equal(facts.unknown, 0);
  assert.equal(facts.unclassified, refs.length - facts.classified);
  assert.equal(facts.classified + facts.unclassified + facts.unknown, facts.requested);
  assert.deepEqual(facts.models.map(row => [row.modelId, row.classified]), federated ? [['a', 7], ['b', 1]] : [['a', 7]]);
  assert.deepEqual(facts.labels.map(row => [row.modelId, row.system, row.Identification, row.elements]),
    federated ? [['a', null, '000', 7], ['b', null, '000', 1]] : [['a', null, '000', 7]]);
  assert.deepEqual(aggregate({ summary: payload.evidence.summary }), facts, 'the frozen actual source keeps sample-independent counts');
});

test('#7238 native source-free edited membership remains unknown over the whole selected population', async t => {
  const a = await model(t); if (!a) return;
  a.store.source = EMPTY_SOURCE_BYTES; seedModel('wire', 0, a.store, SPACES[0]);
  const view = getOrCreateMutationView(useViewerStore, 'wire'); assert.ok(view);
  view.setPositionalAttribute(21173, 4, ['#20909']);
  useViewerStore.setState({ selectedEntities: [], selectedEntitiesSet: new Set(a.ids.map(expressId => entityRefToString({ modelId: 'wire', expressId }))) });
  const capture = selectionAdapter.capture(useViewerStore.getState(), 1);
  const facts = aggregate(capture); assert.ok(facts, 'unavailable native membership needs an explicit full population denominator');
  assert.equal(facts.requested, a.ids.length); assert.equal(facts.classified, 0); assert.equal(facts.unclassified, 0);
  assert.equal(facts.unknown, a.ids.length); assert.equal(facts.status, 'partial');
  assert.deepEqual(facts.labels, [], 'immutable original source markers are not current code distributions');
});

test('#7238 forwarded immutable membership counts classified refs while system/code fields remain unknown', async t => {
  const a = await model(t); if (!a) return;
  a.store.source = EMPTY_SOURCE_BYTES; seedModel('wire', 0, a.store, SPACES[0]);
  useViewerStore.setState({ mutationViews: new Map(), selectedEntities: [],
    selectedEntitiesSet: new Set(a.ids.map(expressId => entityRefToString({ modelId: 'wire', expressId }))) });
  const facts = aggregate(selectionAdapter.capture(useViewerStore.getState(), 1)); assert.ok(facts);
  assert.equal(facts.classified, 7); assert.equal(facts.unclassified, 100); assert.equal(facts.unknown, 0);
  assert.deepEqual(facts.labels.map(row => [row.modelId, row.system, row.Identification, row.elements]), [['wire', null, null, 7]]);
});

test('#7238 equal native display codes do not invent unique classification identities', async t => {
  const a = await model(t); if (!a) return;
  seedModel('a', 0, a.store, SPACES[0]); const view = getOrCreateMutationView(useViewerStore, 'a'); assert.ok(view);
  for (let n = 1; n <= 2; n++) {
    const system = view.createEntity('IfcClassification', ['Native writer', '2026', null, 'Same system label', null, null, null]);
    const ref = view.createEntity('IfcClassificationReference', [null, 'SAME', `Different reference ${n}`, `#${system.expressId}`, null, null]);
    view.createEntity('IfcRelAssociatesClassification', [`000000000000000000000${n}`, null, null, null, ['#20909'], `#${ref.expressId}`]);
  }
  const file = await exportAndReparse('a', a.store);
  // Exported source has two distinct authored classification definitions/reference objects with the same labels.
  assert.equal(file.entityIndex.byType.get('IFCCLASSIFICATION')?.length, 2);
  assert.equal(file.entityIndex.byType.get('IFCCLASSIFICATIONREFERENCE')?.length, 3);
  useViewerStore.setState({ selectedEntities: [], selectedEntitiesSet: new Set([entityRefToString({ modelId: 'a', expressId: 20909 })]) });
  const facts = aggregate(selectionAdapter.capture(useViewerStore.getState(), 1)); assert.ok(facts);
  const label = facts.labels.find(row => row.Identification === 'SAME') as (Aggregate['labels'][number] & { referenceRows: number }) | undefined;
  assert.ok(label); assert.equal(label.elements, 1); assert.equal(label.referenceRows, 2);
  assert.equal(facts.classified, 1, 'classification multiplicity does not inflate the selected member denominator');
});

test('#7238 practical native scan ceiling exposes unscanned requested refs as unknown instead of unclassified', async t => {
  const a = await model(t); if (!a) return;
  const ids = Array.from(a.store.entities.expressId); assert.ok(ids.length > 100);
  seedModel('source-0', 0, a.store, SPACES[0]); const base = useViewerStore.getState().models.get('source-0'); assert.ok(base);
  const models = new Map<string, typeof base>(); const refs: Array<{ modelId: string; expressId: number }> = [];
  // Real native source IDs, separate model-local reference populations, no fabricated Express IDs.
  for (let n = 0; refs.length < 50_001; n++) {
    const modelId = `source-${n}`;
    models.set(modelId, { ...base, id: modelId, name: modelId, idOffset: n * 1_000_000 });
    refs.push(...ids.slice(0, 50_001 - refs.length).map(expressId => ({ modelId, expressId })));
  }
  assert.equal(new Set(refs.map(entityRefToString)).size, 50_001);
  useViewerStore.setState({ models, mutationViews: new Map(), selectedEntities: [], selectedEntitiesSet: new Set(refs.map(entityRefToString)) });
  const facts = aggregate(selectionAdapter.capture(useViewerStore.getState(), 1)); assert.ok(facts);
  const known = refs.slice(0, 50_000).filter(ref => SPACES.includes(ref.expressId)).length;
  assert.equal(facts.requested, 50_001); assert.equal(facts.scanned, 50_000);
  assert.equal(facts.classified, known); assert.equal(facts.unclassified, 50_000 - known);
  assert.equal(facts.unknown, 1); assert.equal(facts.status, 'partial');
  assert.equal(facts.classified + facts.unclassified + facts.unknown, 50_001);
});


test('#7238 native label/model display bounds disclose omitted groups without changing membership totals', async t => {
  const a = await model(t); if (!a) return;
  seedModel('a', 0, a.store, SPACES[0]); const view = getOrCreateMutationView(useViewerStore, 'a'); assert.ok(view);
  for (let n = 0; n < 51; n++) {
    const ref = view.createEntity('IfcClassificationReference', [null, `AUTHORED-${n}`, null, null, null, null]);
    view.createEntity('IfcRelAssociatesClassification', [`0000000000000000000${String(n).padStart(3, '0')}`, null, null, null, ['#20909'], `#${ref.expressId}`]);
  }
  const file = await exportAndReparse('a', a.store);
  assert.equal(file.entityIndex.byType.get('IFCCLASSIFICATIONREFERENCE')?.length, 52);
  useViewerStore.setState({ selectedEntities: [], selectedEntitiesSet: new Set([entityRefToString({ modelId: 'a', expressId: 20909 })]) });
  const labels = aggregate(selectionAdapter.capture(useViewerStore.getState(), 1)); assert.ok(labels);
  assert.equal(labels.classified, 1); assert.equal(labels.referenceRows, 52);
  assert.equal(labels.labels.length, 50); assert.equal(labels.omittedLabelGroups, 2);
  const base = useViewerStore.getState().models.get('a'); assert.ok(base);
  const models = new Map<string, typeof base>();
  const refs = Array.from({ length: 26 }, (_, n) => {
    const modelId = `source-${n}`;
    models.set(modelId, { ...base, id: modelId, name: modelId, idOffset: n * 1_000_000 });
    return { modelId, expressId: SPACES[0] };
  });
  useViewerStore.setState({ models, mutationViews: new Map(), selectedEntitiesSet: new Set(refs.map(entityRefToString)) });
  const facts = aggregate(selectionAdapter.capture(useViewerStore.getState(), 1)); assert.ok(facts);
  assert.equal(facts.requested, 26); assert.equal(facts.classified, 26); assert.equal(facts.unknown, 0);
  assert.equal(facts.models.length, 25); assert.equal(facts.omittedModelGroups, 1);
});
