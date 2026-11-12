/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #9668: the viewer derives an analytical model from the loaded physical one,
// shows the plan for review, writes nothing until Apply, and Apply is one Undo.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { assertSameNativeIfcGraph } from '@/test/native-ifc-graph';
import { extractStructuralOnDemand, structuralCounterparts } from '@ifc-lite/parser';
import { StoreEditor } from '@ifc-lite/mutations';
import { loadStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { useViewerStore } from '@/store';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc, danglingReferences } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { commitStructuralDerivation, derivationModelId, prepareStructuralDerivationReview } from './structural-derive-review';
import { decodeModelChangeReceipt } from './receipts';
import { FRAME } from '@/test/structural-frame-fixture';
import { replayWorkspaceHistory } from '@/lib/model-placement/history';

// The derivation loads with the structural write path (#9668); the review awaits it.
before(() => loadStructuralWrites());
const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

test('#9668 review writes nothing; Apply writes one linked analysis model as one undo step', async () => {
  const { dataStore, view } = await seedAuthoringSample({ bytes: FRAME });
  assert.equal(derivationModelId(useViewerStore.getState()), SAMPLE_MODEL);
  const before = editedModelBytes(dataStore, view);
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  assert.deepEqual(review.plan.report.counts, { curveMembers: 3, surfaceMembers: 0, nodes: 4, supports: 1, guessedSupports: 0, assumedLoadBearing: 3, skipped: 0, extendedEnds: 0, freeEnds: 1 });
  assert.ok(review.created > 0);
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  assert.equal(useViewerStore.getState().storeEditors.size, 0, 'review allocates no live editor');
  const history = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;

  const receipt = commitStructuralDerivation(useViewerStore, review, 'test');
  assert.ok(decodeModelChangeReceipt(JSON.parse(JSON.stringify(receipt))));
  // One row per derived item: the analysis model, 3 members and 4 connections, each with its written record.
  assert.deepEqual(receipt.applied.map((row) => row.op).sort(), ['structural.analysis.create', ...Array(4).fill('structural.connection.create'), ...Array(3).fill('structural.member.create')].sort());
  assert.ok(receipt.applied.every((row) => row.globalId.length === 22 && typeof row.after === 'string'));
  // Every edit the derivation recorded carries its one batch tag, so one Undo reverts all of it.
  const added = (useViewerStore.getState().undoStacks.get(SAMPLE_MODEL) ?? []).slice(history);
  assert.ok(added.length > 0);
  assert.deepEqual(new Set(added.map((mutation) => useViewerStore.getState().mutationBatchTags.get(mutation.id))), new Set([receipt.batches[0].batchId]));
  const text = new TextDecoder().decode(editedModelBytes(dataStore, view));
  assert.deepEqual(danglingReferences(text), []);
  const graph = extractStructuralOnDemand(await parseIfc(new TextEncoder().encode(text)));
  assert.equal(graph.analysisModels.length, 1);
  assert.equal(graph.members.length, 3);
  for (const item of [...graph.members, ...graph.connections]) assert.equal(structuralCounterparts(graph, item.expressId)?.side, 'physical');

  replayWorkspaceHistory(useViewerStore.getState(), 'undo');
  // One Undo removes the whole derivation.
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, history);
});

test('#9668 Apply writes the plan the user reviewed, not a new one', async () => {
  const { dataStore, view } = await seedAuthoringSample({ bytes: FRAME });
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  // Edit the reviewed plan: a fresh plan of the same model would still hold all three members.
  review.plan.curveMembers.pop();
  commitStructuralDerivation(useViewerStore, review, 'test');
  const graph = extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view)));
  assert.equal(graph.members.length, 2);
});

test('#9668 a write failing inside Apply leaves the model and its undo history as they were', async () => {
  const { dataStore, view } = await seedAuthoringSample({ bytes: FRAME });
  const before = editedModelBytes(dataStore, view);
  const history = useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0;
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  // Fail the 20th record Apply writes: after the analysis model and the first connections.
  const addEntity = StoreEditor.prototype.addEntity;
  let calls = 0;
  StoreEditor.prototype.addEntity = function (this: StoreEditor, ...args: Parameters<StoreEditor['addEntity']>) {
    if (++calls === 20) throw new Error('disk full');
    return addEntity.apply(this, args);
  };
  try {
    assert.throws(() => commitStructuralDerivation(useViewerStore, review, 'test'), /disk full/);
  } finally {
    StoreEditor.prototype.addEntity = addEntity;
  }
  assert.equal(calls, 20);
  await assertSameNativeIfcGraph(editedModelBytes(dataStore, view), before);
  assert.equal(useViewerStore.getState().undoStacks.get(SAMPLE_MODEL)?.length ?? 0, history);
});

test('#9668 a second derivation of the same model plans nothing and offers no Apply', async () => {
  await seedAuthoringSample({ bytes: FRAME });
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'first');
  const again = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  assert.equal(again.plan.existingAnalysisModels.length, 1);
  assert.equal(again.plan.refusal, null, 'nothing left to derive, so nothing to refuse');
  assert.equal(again.created, 0);
  assert.throws(() => again.commit(), /nothing it may write/);
});

test('#9668 a model with an authored analysis model is refused before Apply', async () => {
  const authored = new TextDecoder().decode(FRAME).replace('ENDSEC;\nEND-ISO-10303-21;',
    "#99990=IFCSTRUCTURALANALYSISMODEL('0Ab1Cd2Ef3Gh4Ij5Kl6Mn7',$,'Authored',$,$,.LOADING_3D.,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;");
  assert.ok(authored.includes('#99990='));
  await seedAuthoringSample({ bytes: new TextEncoder().encode(authored) });
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  assert.ok(review.plan.curveMembers.length > 0);
  assert.match(review.plan.refusal ?? '', /already has an analysis model \(#99990\)/);
  assert.equal(review.created, 0);
  assert.throws(() => review.commit(), /nothing it may write/);
});

test('#9668 a review goes stale when the model changes before Apply', async () => {
  await seedAuthoringSample({ bytes: FRAME });
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'other');
  assert.throws(() => review.validate(), /changed after this derivation was reviewed/);
  assert.throws(() => review.commit(), /changed after this derivation was reviewed/);
});

test('#9668 a renamed or hidden model, or an edit view opened with no edits, does not make a review stale', async () => {
  const { view } = await seedAuthoringSample({ bytes: FRAME });
  const state = useViewerStore.getState();
  // No edit view at Prepare, as for a model opened without edits.
  useViewerStore.setState({ mutationViews: new Map() });
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  state.setModelVisibility(SAMPLE_MODEL, false);
  useViewerStore.getState().registerMutationView(SAMPLE_MODEL, view);
  assert.doesNotThrow(() => review.validate());
  view.setProperty(1, 'Pset_Test', 'Note', 'edited');
  assert.throws(() => review.validate(), /changed after this derivation was reviewed/);
});

test('#9668 a read-only session is refused before anything is derived', async () => {
  await seedAuthoringSample({ bytes: FRAME, editEnabled: false });
  assert.throws(() => prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL));
});
