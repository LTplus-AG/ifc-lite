/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #10605: the derivation review does not dead-end. Element ids select and frame
// their element, Apply offers the analytical model, and a model that already has
// an analysis model still gets the refusal, with its consistency findings below it.
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, before, test } from 'node:test';
import { extractStructuralOnDemand } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { recordModellingCommit } from '@/store/slices/mutation-modelling-records';
import { toGlobalIdFromModels } from '@/store/globalId';
import { render, click, cleanup, waitFor } from '@/test/render.js';
import { fixtureModel } from '@/test/store-fixture.js';
import { seedAuthoringSample, SAMPLE_MODEL, parseIfc } from '@/test/authoring-sample-fixture';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { FRAME } from '@/test/structural-frame-fixture';
import { loadStructuralWrites } from '@/sdk/adapters/store-adapter-structural';
import { commitStructuralDerivation, prepareStructuralDerivationReview } from '@/lib/actions/structural-derive-review';
import { StructuralDerivationReview, DerivationSummary } from './StructuralDerivationReview';

before(() => loadStructuralWrites());
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const buttons = (root: HTMLElement) => [...root.querySelectorAll('button')];
const button = (root: HTMLElement, text: RegExp) => buttons(root).find((b) => text.test(b.textContent ?? ''));
const text = (root: HTMLElement) => root.textContent ?? '';

/** The frame model alone, or behind another model so its ids are offset (federation, models.size N). */
async function seed(federated: boolean, bytes: Uint8Array = FRAME) {
  const seeded = await seedAuthoringSample({ bytes });
  if (federated) {
    const frame = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    useViewerStore.setState({
      models: new Map([['other', fixtureModel('other')], [SAMPLE_MODEL, { ...frame, idOffset: 1_000_000 }]]),
      activeModelId: SAMPLE_MODEL,
    });
  }
  return seeded;
}

/** The model as edited, written out with the beam B1's axis raised 0.5 m: a derived member left behind. */
function raisedBeam(dataStore: Parameters<typeof editedModelBytes>[0], view: Parameters<typeof editedModelBytes>[1]): Uint8Array {
  const derived = new TextDecoder().decode(editedModelBytes(dataStore, view));
  const moved = derived
    .replace(/#60=IFCCARTESIANPOINT\(\(0\.,0\.,3\.\)\);/, '#60=IFCCARTESIANPOINT((0.,0.,3.5));')
    .replace(/#61=IFCCARTESIANPOINT\(\(6\.,0\.,3\.\)\);/, '#61=IFCCARTESIANPOINT((6.,0.,3.5));');
  assert.notEqual(moved, derived, 'the beam axis points were rewritten');
  return new TextEncoder().encode(moved);
}

const globalId = (expressId: number) => toGlobalIdFromModels(useViewerStore.getState().models, SAMPLE_MODEL, expressId);

for (const federated of [false, true]) {
  test(`#10605 a review row's element selects and frames that element (${federated ? 'two models' : 'one model'})`, async () => {
    await seed(federated);
    const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
    // The left column C1 (#50) stands on no footing: its foot is the frame's one free end.
    assert.deepEqual(review.plan.report.freeEnds.map((node) => review.plan.nodes[node].elementIds), [[50]]);
    let framed = 0;
    useViewerStore.setState({ cameraCallbacks: { frameSelection: () => { framed++; } } });
    const root = render(<DerivationSummary review={review} />);
    assert.match(text(root), /Free member ends, meeting no other member and no support \(1\)/);
    const column = button(root, /^#50 C1 \(IfcColumn\)$/);
    assert.ok(column, `the free end lists C1 as a button; rows read: ${text(root)}`);
    click(column);
    const state = useViewerStore.getState();
    assert.deepEqual(state.selectedEntity, { modelId: SAMPLE_MODEL, expressId: 50 });
    assert.equal(state.selectedEntityId, federated ? 1_000_050 : 50);
    assert.deepEqual([...state.selectedEntityIds], [federated ? 1_000_050 : 50]);
    await waitFor(() => framed === 1, 'the selection is framed');
  });
}

test('#10605 moved ends and unconnected ends link both elements; the leading # is not doubled', async () => {
  await seed(true);
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  review.plan.report.extendedEnds = [{ elementId: 65, end: 'start', distance: 0.15, toElementId: 50 }];
  review.plan.report.unconnectedEnds = [{ node: 0, landsOn: 'member-interior', landsOnElementId: 65 }];
  const root = render(<DerivationSummary review={review} />);
  assert.match(text(root), /#65 B1 \(IfcBeam\) start: 0\.150 m to meet #50 C1 \(IfcColumn\)/);
  assert.doesNotMatch(text(root), /##/);
  assert.match(text(root), /Node 1: .* m, on member #65 B1 \(IfcBeam\)/);
  const moved = buttons(root).filter((b) => b.textContent === '#65 B1 (IfcBeam)');
  assert.equal(moved.length, 2, 'the beam is a button in both rows');
  click(button(root, /^#50 C1/)!);
  assert.equal(useViewerStore.getState().selectedEntityId, 1_000_050);
});

test('#10605 after Apply, "Show analytical model" switches to the analytical view and selects the new analysis model', async () => {
  const { dataStore, view } = await seed(true);
  const root = render(<StructuralDerivationReview origin="test" />);
  await waitFor(() => button(root, /Derive and review/)?.disabled === false, 'the structural write path loads');
  assert.equal(button(root, /Show analytical model/), undefined, 'nothing to show before Apply');
  click(button(root, /Derive and review/)!);
  await waitFor(() => !!root.querySelector('input[type="checkbox"]'), 'the plan is shown');
  click(root.querySelector('input[type="checkbox"]')!);
  await waitFor(() => button(root, /^Apply/)?.disabled === false, 'acknowledged');
  click(button(root, /^Apply/)!);
  await waitFor(() => !!button(root, /Show analytical model/), 'Apply offers the analytical model');
  // The exported file keeps the overlay's ids, so the parsed graph names the live entities.
  const graph = extractStructuralOnDemand(await parseIfc(editedModelBytes(dataStore, view)));
  const [analysis] = graph.analysisModels;
  assert.equal(useViewerStore.getState().structuralViewMode, 'both');
  click(button(root, /Show analytical model/)!);
  const state = useViewerStore.getState();
  assert.equal(state.structuralViewMode, 'analytical');
  assert.deepEqual(state.selectedEntity, { modelId: SAMPLE_MODEL, expressId: analysis.expressId });
  assert.equal(state.selectedEntityId, globalId(analysis.expressId));
  assert.ok(analysis.expressId > 0 && state.selectedEntityId! > 1_000_000);
  // The group owns no geometry: its three members are highlighted and framed with it, the group last.
  assert.deepEqual([...state.selectedEntityIds].sort(), [...graph.members.map((m) => globalId(m.expressId)), globalId(analysis.expressId)].sort());
  assert.equal([...state.selectedEntityIds].at(-1), globalId(analysis.expressId));
});

test('#10605 an analysis model derived this session is reported consistent, with a way to show it', async () => {
  await seed(false);
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'first');
  const root = render(<StructuralDerivationReview origin="test" />);
  await waitFor(() => button(root, /Derive and review/)?.disabled === false, 'the structural write path loads');
  click(button(root, /Derive and review/)!);
  await waitFor(() => /consistent with the physical model/.test(text(root)), `the check finishes: ${text(root)}`);
  assert.doesNotMatch(text(root), /disagree/);
  assert.ok(button(root, /Show analytical model/));
  assert.ok(button(root, /\(IfcStructuralAnalysisModel\)$/), 'the analysis model itself is a link');
});

test('#10605 a physical element moved since derivation is listed as stale, and its row selects it', async () => {
  // Derive, export, then move the beam B1 up 0.5 m: its derived member and record stay where they were.
  const { dataStore, view } = await seed(false);
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'first');
  await seed(true, raisedBeam(dataStore, view));

  const root = render(<StructuralDerivationReview origin="test" />);
  await waitFor(() => button(root, /Derive and review/)?.disabled === false, 'the structural write path loads');
  click(button(root, /Derive and review/)!);
  await waitFor(() => /disagree/.test(text(root)), `the check finishes: ${text(root)}`);
  const rows = [...root.querySelectorAll('section[aria-label="Analysis model check"] li')].map((li) => li.textContent ?? '');
  assert.match(rows[0], /is out of date: #65 B1 \(IfcBeam\) moved 0\.500 m since it was derived/);
  assert.ok(rows.some((row) => /lies 0\.500 m off the axis of #65 B1 \(IfcBeam\)/.test(row)), rows.join('\n'));
  const beam = [...root.querySelectorAll('section[aria-label="Analysis model check"] li button')].find((b) => b.textContent === '#65 B1 (IfcBeam)');
  assert.ok(beam);
  click(beam);
  assert.deepEqual(useViewerStore.getState().selectedEntity, { modelId: SAMPLE_MODEL, expressId: 65 });
  assert.equal(useViewerStore.getState().selectedEntityId, 1_000_065);
});

test('#10605 each "Derive and review" checks the model again: a beam moved after the first check is reported', async () => {
  await seed(false);
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'first');
  const root = render(<StructuralDerivationReview origin="test" />);
  await waitFor(() => button(root, /Derive and review/)?.disabled === false, 'the structural write path loads');
  click(button(root, /Derive and review/)!);
  await waitFor(() => /consistent with the physical model/.test(text(root)), `the first check finishes: ${text(root)}`);
  // Raise the beam B1 (#65) 0.5 m in the session, by its axis points, then review the same model again.
  recordModellingCommit(useViewerStore, SAMPLE_MODEL, (editor) => {
    editor.setPositionalAttribute(60, 0, [0, 0, 3.5]);
    editor.setPositionalAttribute(61, 0, [6, 0, 3.5]);
  });
  click(button(root, /Derive and review/)!);
  await waitFor(() => /disagree/.test(text(root)), `the second check reports the move: ${text(root)}`);
  assert.match(text(root), /is out of date: #65 B1 \(IfcBeam\) moved 0\.500 m since it was derived/);
  assert.doesNotMatch(text(root), /consistent with the physical model/);
});

test('#10605 with no readable axes (IFC5), "no findings" does not claim the movement and drift checks ran', async () => {
  // A derived model whose beam has moved since, so a check that read the axes would report it stale.
  const first = await seed(false);
  commitStructuralDerivation(useViewerStore, prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL), 'first');
  const { dataStore } = await seed(false, raisedBeam(first.dataStore, first.view));
  const review = prepareStructuralDerivationReview(useViewerStore, SAMPLE_MODEL);
  // The physical axes are read for every schema but IFC5 (the derivation itself refuses IFC5 up front).
  dataStore.schemaVersion = 'IFC5';
  const root = render(<DerivationSummary review={review} />);
  await waitFor(() => /Movement and axis drift were not checked/.test(text(root)), `the check finishes: ${text(root)}`);
  assert.doesNotMatch(text(root), /consistent with the physical model|no structural item has moved/);
});
