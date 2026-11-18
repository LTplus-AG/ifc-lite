/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { act } from 'react';
import type { GeometryResult } from '@ifc-lite/geometry';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { render, cleanup, click, type, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { pendingGeorefSectionFocus, requestGeorefSectionFocus } from '@/lib/site-context/georef-section-focus';
import { GeorefEmptyState } from './properties/georef-empty-state';
import { GeoreferencingPanel } from './properties/GeoreferencingPanel';
import { parseFixtureModel } from './anonymized-export/anonymized-export-fixture.test-support';
import { KmzExportDialog } from './KmzExportDialog';
import { CesiumIonExportDialog } from './CesiumIonExportDialog';

const geometryResult: GeometryResult = {
  meshes: [], totalTriangles: 0, totalVertices: 0,
  coordinateInfo: {
    originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  },
};
const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
const button = (text: string) => {
  const found = [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === text);
  assert.equal(!!found, true, `Missing button: ${text}`);
  return found!;
};

for (const format of ['kmz', 'ion'] as const) {
  const open = async () => {
    const model = { ...fixtureModel('unlocated'), geometryResult, ifcDataStore: await parseFixtureModel(), schemaVersion: 'IFC4' as const };
    useViewerStore.setState({ ...fixtureModels(model), georefMutations: new Map() });
    render(format === 'kmz' ? <KmzExportDialog surface="ribbon" /> : <CesiumIonExportDialog surface="ribbon" />);
    click(button(format === 'kmz' ? 'Export KMZ' : 'Upload to Cesium ion'));
    if (format === 'ion') type(document.querySelector<HTMLInputElement>('#ion-token')!, 'test-token');
  };

  test(`#10647 ${format} prechecks on open and routes to the selected model's add row`, async () => {
    await open();
    assert.equal(document.body.textContent?.includes('This model has no georeferencing.'), true);
    assert.equal(button(format === 'kmz' ? 'Export' : 'Upload').disabled, true);
    click(button('Open georeferencing'));
    await waitFor(() => !document.querySelector('[role="dialog"]'), 'export dialog did not close');
    assert.equal(pendingGeorefSectionFocus()?.modelId, 'unlocated');
    assert.equal(pendingGeorefSectionFocus()?.section, 'addGeoref');
    assert.equal(useViewerStore.getState().selectedModelId, 'unlocated');
    render(<GeorefEmptyState modelId="unlocated" editable schemaNotice={false} georef={null} onEpsgSelect={() => {}} />);
    assert.equal(pendingGeorefSectionFocus() === null, true);
    assert.equal(document.activeElement?.textContent?.trim(), 'Add Georeferencing');
  });

  test(`#10647 ${format} includes session georeferencing edits and updates while open`, async () => {
    await open();
    act(() => useViewerStore.setState({ georefMutations: new Map([['unlocated', {
      mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 0 },
      projectedCRS: { name: 'EPSG:2056' },
    }]]) }));
    assert.equal(document.body.textContent?.includes('This model has no georeferencing.'), false);
    assert.equal(button(format === 'kmz' ? 'Export' : 'Upload').disabled, false);
    act(() => useViewerStore.setState({ georefMutations: new Map() }));
    assert.equal(button(format === 'kmz' ? 'Export' : 'Upload').disabled, true);
  });
}

for (const schemaNotice of [false, true]) {
  test(`#10647 read-only add row consumes focus and focuses the notice (schema notice ${schemaNotice})`, () => {
    requestGeorefSectionFocus('readonly', 'addGeoref');
    render(<GeorefEmptyState modelId="readonly" editable={false} schemaNotice={schemaNotice} georef={null} onEpsgSelect={() => {}} />);
    assert.equal(pendingGeorefSectionFocus() === null, true);
    assert.equal(document.activeElement?.getAttribute('data-georef-focus'), '');
    assert.equal(document.activeElement?.textContent?.includes(schemaNotice ? 'IFC2' : 'No georeferencing'), true);
  });
}

const HALF_GEOREF = {
  crs: { projectedCRS: { id: 71, name: 'EPSG:2056' }, action: 'Add Coordinates' },
  conversion: { mapConversion: { id: 73, sourceCRS: 41, targetCRS: 71, eastings: 2600000, northings: 1200000, orthogonalHeight: 0 }, action: 'Add CRS' },
} as const;
for (const [half, { action, ...georef }] of Object.entries(HALF_GEOREF)) {
  test(`#10647 a model with only a ${half} routes to the row that completes it`, () => {
    requestGeorefSectionFocus(`half-${half}`, 'addGeoref');
    render(<GeoreferencingPanel georef={{ hasGeoreference: false, ...georef } as never} schemaVersion="IFC4" modelId={`half-${half}`} enableEditing />);
    assert.equal(pendingGeorefSectionFocus() === null, true);
    assert.equal(document.activeElement?.textContent?.trim(), action);
  });
}

test('#10647 kmz legacy single-model path sees session edits stored under __legacy__', async () => {
  useViewerStore.setState({ models: new Map(), ifcDataStore: await parseFixtureModel(), geometryResult, georefMutations: new Map([['__legacy__', {
    mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 0 },
    projectedCRS: { name: 'EPSG:2056' },
  }]]) });
  render(<KmzExportDialog surface="ribbon" />);
  click(button('Export KMZ'));
  assert.equal(document.body.textContent?.includes('This model has no georeferencing.'), false);
  assert.equal(button('Export').disabled, false);
});
