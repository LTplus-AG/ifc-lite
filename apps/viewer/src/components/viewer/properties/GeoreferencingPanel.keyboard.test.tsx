/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, click, press, render } from '@/test/render.js';
import type { GeoreferenceInfo } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { GeoreferencingPanel } from './GeoreferencingPanel.js';

const georef: GeoreferenceInfo = {
  hasGeoreference: true,
  source: 'mapConversion',
  projectedCRS: { id: 71, name: 'EPSG:25833', mapUnitScale: 1 },
  mapConversion: {
    id: 73, sourceCRS: 41, targetCRS: 71,
    eastings: 311_988, northings: 5_996_148, orthogonalHeight: 12,
    xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
  },
};
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

it('#5823 opens georeference field editors with Enter and Space', () => {
  const ui = render(<GeoreferencingPanel georef={georef} modelId="A" enableEditing schemaVersion="IFC4" />);
  const projectedHeading = [...ui.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Projected CRS'));
  assert.ok(projectedHeading);
  click(projectedHeading);

  const nameRow = [...ui.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((row) => row.textContent?.includes('EPSG:25833'));
  assert.ok(nameRow, 'editable CRS name row must be keyboard reachable');
  nameRow.focus();
  press(nameRow, 'Enter');
  assert.ok(nameRow.querySelector('input'), 'Enter opens the same editor as a click');
  press(nameRow.querySelector('input')!, 'Escape');

  const operationHeading = [...ui.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Coordinate Operation'));
  assert.ok(operationHeading);
  click(operationHeading);
  const angleRow = [...ui.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((row) => row.textContent?.includes('Angle to Grid North'));
  assert.ok(angleRow, 'editable angle row must be keyboard reachable');
  angleRow.focus();
  press(angleRow, ' ');
  assert.ok(angleRow.querySelector('input'), 'Space opens the angle editor');
});

it('#5823 leaves the height row closed when the terrain button receives Enter', () => {
  useViewerStore.setState({
    cesiumEnabled: true, cesiumTerrainHeight: 20, cesiumTerrainSaveHeight: 20,
    cesiumSourceModelId: 'A',
  });
  const ui = render(<GeoreferencingPanel georef={georef} modelId="A" enableEditing schemaVersion="IFC4" />);
  const operationHeading = [...ui.querySelectorAll('button')]
    .find((button) => button.textContent?.includes('Coordinate Operation'));
  assert.ok(operationHeading);
  click(operationHeading);
  const heightRow = [...ui.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((row) => row.textContent?.includes('OrthogonalHeight'));
  assert.ok(heightRow);
  const terrainButton = heightRow.querySelector<HTMLButtonElement>('button');
  assert.ok(terrainButton);
  press(terrainButton, 'Enter');
  assert.equal(heightRow.querySelector('input'), null, 'terrain activation must not open the inline editor');
});
