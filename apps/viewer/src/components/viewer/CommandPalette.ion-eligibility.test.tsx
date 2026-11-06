/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { cleanup, click, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { mountDestinations, searchDestination, destinationOption, namedButton } from '@/test/palette-destinations';
import { parseIfcxViewerModel } from '@/hooks/ingest/viewerModelIngest';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { listIonExportModels } from './export-model-selection';

const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose();
  useViewerStore.setState(initial); localStorage.clear();
});
const ion = () => destinationOption('export:ion');

test('#8947 actual IFCX refuses ion; adding STEP opens its real model/token flow and removal restores refusal', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    header: { id: 'palette-ion', ifcxVersion: 'ifcx-alpha', dataVersion: '1', author: 'test', timestamp: '' },
    imports: [], schemas: {}, data: [],
  }));
  const parsed = await parseIfcxViewerModel(bytes.buffer);
  assert.equal(parsed.schemaVersion, 'IFC5');
  const ifcx = { ...fixtureModel('unsupported.ifcx'), ifcDataStore: parsed.dataStore,
    geometryResult: parsed.geometryResult, schemaVersion: parsed.schemaVersion };
  useViewerStore.setState({ ...fixtureModels(ifcx), ifcDataStore: parsed.dataStore,
    collabRole: null, mutationViews: new Map(), georefMutations: new Map() });
  hosts.push(mountDestinations(null)); searchDestination('cesium ion');
  assert.equal(ion().getAttribute('aria-disabled'), 'true');
  assert.match(ion().textContent ?? '', /Load a STEP IFC model/);
  click(ion()); await advance(60);
  assert.ok(document.querySelector('[role="combobox"]'), 'blocked activation leaves the palette open');
  assert.equal(document.querySelector('#ion-token'), null);

  const step = { ...fixtureModel('eligible.ifc'), ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
  // The active model remains IFCX: the dialog may choose another eligible federation member.
  act(() => useViewerStore.setState({ models: new Map([[ifcx.id, ifcx], [step.id, step]]) }));
  assert.notEqual(ion().getAttribute('aria-disabled'), 'true');
  click(ion());
  await waitFor(() => document.querySelector('#ion-model')?.textContent?.includes('eligible.ifc') === true,
    'canonical export runner opens the eligible STEP model in the actual ion dialog');
  assert.equal(document.querySelector<HTMLInputElement>('#ion-token')?.type, 'password');
  assert.equal(namedButton('Upload').disabled, true, 'token configuration is required; no remote operation attempted');
  click(namedButton('Close')); await advance(30);
  searchDestination('cesium ion');
  act(() => useViewerStore.setState({ models: new Map([[ifcx.id, ifcx]]) }));
  assert.equal(ion().getAttribute('aria-disabled'), 'true');
  assert.match(ion().textContent ?? '', /IFCX and LandXML/);
});

test('#8947 ion never resurrects an excluded capture via the active legacy store', async () => {
  const data = await parseFixtureModel();
  const capture = { ...fixtureModel('capture'), ifcDataStore: data,
    gaussianSplat: {
      handle: { id: 1, modelIndex: 1 }, format: 'splat' as const, count: 3, shDegree: 0 as const,
      sourceCenterBounds: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
      placement: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      placementOrigin: 'source' as const, calibration: 'uncalibrated' as const,
    },
  };
  // Format exclusion is a metadata invariant, independent of capture geometry.
  assert.deepEqual(listIonExportModels(new Map([[capture.id, capture]]), data), []);
  assert.deepEqual(listIonExportModels(new Map(), data).map(model => model.id), ['__legacy__'],
    'the genuine pre-federation STEP context still has a destination');
});
