/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { activate, cleanup, click, press, render } from '@/test/render.js';
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
  assert.equal(document.activeElement, nameRow, 'closing the field restores the initiating row focus');

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
  press(angleRow.querySelector('input')!, 'Escape');
  assert.equal(document.activeElement, angleRow, 'closing the angle editor restores its row focus');
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
  const heightValue = ui.querySelector<HTMLButtonElement>('button[aria-label^="OrthogonalHeight:"]');
  assert.ok(heightValue);
  const heightRow = heightValue.parentElement?.parentElement?.parentElement;
  assert.ok(heightRow);
  assert.equal(heightRow.getAttribute('role'), null, 'the terrain button is not nested inside another button role');
  const terrainButton = [...heightRow.querySelectorAll<HTMLButtonElement>('button')].find((button) => button !== heightValue);
  assert.ok(terrainButton);
  activate(terrainButton, 'Enter');
  assert.equal(heightRow.querySelector('input'), null, 'terrain activation must not open the inline editor');
  click(heightRow);
  assert.equal(heightRow.querySelector('input'), null, 'a row with an inline action has no mouse-only edit area');
  activate(heightValue, 'Enter');
  assert.ok(heightRow.querySelector('input'), 'the separate value target still opens the editor');
  press(heightRow.querySelector('input')!, 'Escape');
  const restoredValue = ui.querySelector<HTMLButtonElement>('button[aria-label^="OrthogonalHeight:"]');
  assert.ok(restoredValue);
  assert.equal(document.activeElement, restoredValue, 'the separate value target regains focus');
  activate(restoredValue, ' ');
  assert.ok(heightRow.querySelector('input'), 'Space also opens the native value button');
});
