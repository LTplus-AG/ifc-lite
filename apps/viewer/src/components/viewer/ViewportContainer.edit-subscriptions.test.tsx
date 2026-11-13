/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { after, afterEach, it } from 'node:test';
import { act } from 'react';
import { render, cleanup, advance } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { fixtureStep, seedModelingSession, MODEL_ID, STOREY } from '@/test/modeling-session-fixture';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { usePlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { useAnchorGeoreference } from '@/lib/geo/useAnchorGeoreference';
import { ViewportContainer } from './ViewportContainer';
import { fieldTelemetry } from '@/lib/perf/fieldTelemetryLoader';
after(() => fieldTelemetry?.resetFieldEventsForTests());
afterEach(cleanup);

it('#9296 viewport georeference ignores a column Move/Undo and still publishes its own edit/undo/redo', async () => {
  const step = fixtureStep({}).replace('ENDSEC;\nEND-ISO-10303-21;', `
#160=IFCMAPCONVERSION(#20,#161,2619073.,1263523.,0.,$,$,$);
#161=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95',$,$,$,$,#31);
ENDSEC;\nEND-ISO-10303-21;`);
  await seedModelingSession({ step });
  const restoreRemesh = setRequestRemesh(() => {});
  const made = useViewerStore.getState().addColumn(MODEL_ID, STOREY, { Position: [1, 1, 0], Width: .3, Depth: .3, Height: 3 });
  assert.ok('expressId' in made);
  useViewerStore.setState({ cesiumEnabled: false, solarEnabled: false, anchorModelIdOverride: null, georefMutations: new Map() });
  const gpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');
  Object.defineProperty(navigator, 'gpu', { configurable: true, value: { requestAdapter: async () => ({ features: new Set(), limits: {} }) } });
  let renders = 0;
  let anchorRenders = 0;
  function AnchorReadout() {
    anchorRenders++;
    const anchor = useAnchorGeoreference();
    return <output data-anchor>{anchor?.eff.mapConversion?.eastings ?? 'absent'}</output>;
  }
  function Readout() {
    renders++;
    const context = usePlacementGeorefContext();
    return <output>{context?.mapConversion.eastings ?? 'absent'}</output>;
  }
  try {
    render(<ViewportContainer />);
    const ui = render(<Readout />);
    const anchorUi = render(<AnchorReadout />);
    await advance(100);
    assert.equal(ui.textContent, '2619073');
    assert.equal(anchorUi.textContent, '2619073');
    const beforeAnchor = anchorRenders;
    const before = renders;
    act(() => { assert.ok(useViewerStore.getState().translateEntity(MODEL_ID, made.expressId, [.5, 0, 0]).ok); });
    assert.equal(renders, before, 'a placement edit must not republish an identical georeference');
    assert.equal(anchorRenders, beforeAnchor, 'a column placement does not schedule anchor consumers');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.equal(renders, before);
    act(() => useViewerStore.getState().setGeorefField(MODEL_ID, 'mapConversion', 'eastings', 2619100, 2619073));
    assert.equal(ui.textContent, '2619100');
    assert.equal(anchorUi.textContent, '2619100');
    act(() => useViewerStore.getState().undo(MODEL_ID));
    assert.equal(ui.textContent, '2619073');
    assert.equal(anchorUi.textContent, '2619073');
    act(() => useViewerStore.getState().redo(MODEL_ID));
    assert.equal(ui.textContent, '2619100');
    assert.equal(anchorUi.textContent, '2619100');
  } finally {
    cleanup(); restoreRemesh();
    if (gpu) Object.defineProperty(navigator, 'gpu', gpu);
    else Reflect.deleteProperty(navigator, 'gpu');
  }
});
