/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The flood check's result in the viewer, from a real `@ifc-lite/flood-check`
 * result (the package's pure check over a synthetic building and map, see
 * `test/flood-check-fixture.ts`): the verdict colours reach the overlay
 * compositor keyed by global id, the panel summary and the element card show
 * the package's caveats with the verdicts, the hazard legend appears exactly
 * while the map is draped, and removing the model takes the result with it.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { BAFU_ATTRIBUTION } from '@ifc-lite/flood-check';
import { ProjectUnits } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { cleanup, render } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { floodCheckFixture } from '@/test/flood-check-fixture';
import { useViewerStore } from '@/store';
import { OUTCOME_COLOURS } from '@/lib/flood-check/flood-verdicts';
import { FLOOD_OVERLAY_LAYER_ID, FloodCheckOverlay } from './FloodCheckOverlay';
import { FloodCheckSummary } from './FloodCheckSummary';
import { FloodExposureCard } from '../properties/FloodExposureCard';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

const OFFSET = 1_000_000;
const units = ProjectUnits.empty();

function seed(): ReturnType<typeof floodCheckFixture> {
  const data = floodCheckFixture();
  useViewerStore.setState({ ...fixtureModels(fixtureModel('context'), fixtureModel('building', { idOffset: OFFSET })) });
  const run = new AbortController();
  act(() => {
    useViewerStore.getState().beginFloodCheck('building', run);
    useViewerStore.getState().finishFloodCheck(run, data);
  });
  return data;
}

test('the fixture is a real result: the south door is exposed, the north door is not reassured without other buildings', () => {
  const { result } = floodCheckFixture();
  const byId = new Map(result.results.map((r) => [r.candidate.expressId, r]));
  assert.equal(byId.get(1)?.outcome, 'exposed');
  assert.equal(byId.get(2)?.outcome, 'unclassified');
  assert.equal(byId.get(2)?.unclassifiedReason, 'other-buildings-unknown', 'no source of other buildings: "no runoff mapped" is withheld');
});

test('verdict colours go to the overlay compositor by global id, and come off with the toggle and with the model', () => {
  seed();
  render(<FloodCheckOverlay />);
  const layer = () => useViewerStore.getState().overlayLayers.get(FLOOD_OVERLAY_LAYER_ID);
  const toGlobal = (id: number) => useViewerStore.getState().toGlobalId('building', id);
  assert.deepEqual(layer()?.colorOverrides?.get(toGlobal(1)), OUTCOME_COLOURS.exposed);
  assert.deepEqual(layer()?.colorOverrides?.get(toGlobal(2)), OUTCOME_COLOURS.unclassified);
  assert.equal(layer()?.colorOverrides?.size, 2, 'only checked elements are coloured');
  assert.equal(layer()?.hiddenIds, null, 'the check never hides anything');
  const legend = document.querySelector('[data-testid="flood-verdict-legend"]');
  assert.match(legend?.textContent ?? '', /Exposed\s*1/);
  assert.match(legend?.textContent ?? '', /Not a flood simulation/);

  act(() => useViewerStore.getState().setFloodColoursShown(false));
  assert.equal(layer(), undefined);
  assert.equal(document.querySelector('[data-testid="flood-verdict-legend"]'), null);
  act(() => useViewerStore.getState().setFloodColoursShown(true));
  assert.ok(layer());

  act(() => useViewerStore.getState().removeModel('building'));
  assert.equal(useViewerStore.getState().floodCheck, null, 'the result belongs to its model');
  assert.equal(layer(), undefined);
});

test('editing the checked model drops its verdicts: they describe the file as loaded, not the edited model', () => {
  seed();
  render(<FloodCheckOverlay />);
  assert.ok(useViewerStore.getState().overlayLayers.get(FLOOD_OVERLAY_LAYER_ID));
  act(() => {
    const view = new MutablePropertyView(null, 'building');
    view.setAttribute(1, 'Name', 'Moved door');
    useViewerStore.setState({ mutationViews: new Map([...useViewerStore.getState().mutationViews, ['building', view]]) });
  });
  const run = useViewerStore.getState().floodCheck;
  assert.equal(run?.status, 'error');
  assert.equal(run?.error?.code, 'model-edited');
  assert.equal(run?.data, null);
  assert.equal(useViewerStore.getState().overlayLayers.get(FLOOD_OVERLAY_LAYER_ID), undefined);
});

test('the hazard legend is shown exactly while the overland flow map is draped on a visible terrain', () => {
  useViewerStore.setState({ ...fixtureModels(fixtureModel('terrain')) });
  render(<FloodCheckOverlay />);
  const legend = () => document.querySelector('[data-testid="flood-hazard-legend"]');
  const attribution = { datasetId: 'surfaceRunoff', text: '© FOEN', licence: 'open', termsUrl: 'https://example.invalid', restrictions: [], termsVerifiedOn: '2026-11-16' };
  act(() => useViewerStore.getState().registerSiteContextModel('terrain', { kind: 'terrain', attribution: [], issues: [], complete: true, origin: [0, 0, 0] }));
  assert.equal(legend(), null);
  act(() => useViewerStore.getState().updateSiteContextModel('terrain', { hazard: { attribution, groundSampleDistance: 0.25 } }));
  const text = legend()?.textContent ?? '';
  for (const label of ['Flow depth 0 < h ≤ 0.1 m', 'Flow depth 0.1 < h ≤ 0.25 m', 'Flow depth h > 0.25 m', 'Watercourse']) assert.ok(text.includes(label), label);
  assert.match(text, /Not legally binding/);
  act(() => useViewerStore.setState({ models: new Map([...useViewerStore.getState().models].map(([id, m]) => [id, { ...m, visible: false }])) }));
  assert.equal(legend(), null, 'a hidden terrain shows no legend');
});

test('the panel summary carries the package caveats, the publisher disclaimer and the source with every result', () => {
  const data = seed();
  render(<FloodCheckSummary data={data} />);
  const summary = document.querySelector('[data-testid="flood-check-summary"]')!;
  assert.equal(summary.querySelector('[data-outcome="exposed"]')?.textContent?.trim().endsWith('1'), true);
  const notes = document.querySelector('[data-testid="flood-check-notes"]')?.textContent ?? '';
  assert.ok(notes.includes(data.result.caveat.en));
  assert.ok(notes.includes(data.result.heightReference.residualRisk.en));
  for (const warning of data.result.warnings) assert.ok(notes.includes(warning));
  assert.match(document.querySelector('[data-testid="flood-check-disclaimer"]')?.textContent ?? '', /not legally binding/);
  const source = document.querySelector('[data-testid="flood-check-source"]')?.textContent ?? '';
  assert.ok(source.includes(BAFU_ATTRIBUTION));
  assert.ok(source.includes('2018-05-22'));
});

test('the property panel shows the element verdict with what it means, and says the set is not in the model', () => {
  const data = seed();
  render(<FloodExposureCard modelId="building" expressId={1} projectUnits={units} projectUnitsAvailable />);
  const card = document.querySelector('[data-testid="flood-exposure-card"]');
  assert.equal(card?.getAttribute('data-outcome'), 'exposed');
  const text = card?.textContent ?? '';
  assert.ok(text.includes(data.result.results[0].meaning.en));
  assert.match(text, /Flow depth 0\.1 < h ≤ 0\.25 m/);
  assert.match(text, /not written to the model/);
  assert.match(text, /IfcLite_SurfaceRunoffExposure/);
  cleanup();
  render(<FloodExposureCard modelId="context" expressId={1} projectUnits={units} projectUnitsAvailable />);
  assert.equal(document.querySelector('[data-testid="flood-exposure-card"]'), null, 'a result belongs to the checked model only');
});
