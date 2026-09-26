/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GeoreferencingPanel` labelling (#5812): every editable field's inline
 * `<input>`/`<select>` is reachable by `getByRole(..., { name })`, and the
 * "heights are ellipsoidal" checkbox (now the `Checkbox` primitive) is
 * reachable by `getByLabelText`. Also covers the row's click-to-edit control
 * staying a single, stable DOM node across the non-editing/editing switch —
 * a real regression this PR introduced and fixed (see `georef-rows.tsx`):
 * swapping the outer element to a `<button>` only while editing made React
 * remount the row, detaching any element reference captured before the
 * click that opens it.
 */
import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { GeoreferencingPanel } from './GeoreferencingPanel.js';

afterEach(() => {
  cleanup();
});

const MAP_CONVERSION: MapConversion = {
  id: 73,
  sourceCRS: 41,
  targetCRS: 71,
  eastings: 311_988.181,
  northings: 5_996_148.565,
  orthogonalHeight: 12,
  xAxisAbscissa: 0,
  xAxisOrdinate: 1,
  scale: 1,
};

const PROJECTED_CRS: ProjectedCRS = {
  id: 71,
  name: 'EPSG:25833',
  description: 'ETRS89 / UTM zone 33N',
  geodeticDatum: 'ETRS89',
  mapUnitScale: 1,
} as ProjectedCRS;

function getByRoleTextbox(container: ParentNode, name: string): HTMLInputElement | HTMLSelectElement {
  const candidates = [
    ...container.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'),
  ];
  const match = candidates.find((el) => el.getAttribute('aria-label') === name);
  assert.ok(match, `no <input>/<select> with accessible name "${name}"`);
  return match;
}

function getByLabelText(container: ParentNode, text: string): HTMLElement {
  const label = [...container.querySelectorAll('label')].find((el) => el.textContent?.includes(text));
  assert.ok(label, `no <label> containing "${text}"`);
  const forId = label.getAttribute('for');
  assert.ok(forId, `<label> for "${text}" has no htmlFor`);
  const control = container.querySelector(`#${forId}`);
  assert.ok(control, `no element with id "${forId}"`);
  return control as HTMLElement;
}

function openCoordinateOperation(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Coordinate Operation'));
  assert.ok(trigger, 'Coordinate Operation trigger must render');
  click(trigger);
}

describe('GeoreferencingPanel accessibility (#5812)', () => {
  it('a GerefRow value control is reachable by getByRole(..., { name }) once opened', () => {
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    openCoordinateOperation(container);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    assert.ok(scaleLabel?.parentElement, 'Scale row renders');
    const row = scaleLabel.parentElement;
    click(row);
    const input = getByRoleTextbox(container, 'Scale');
    assert.equal(input, row.querySelector('input'), 'the labelled control is the one this same row now shows');
  });

  it('keeps the row a single DOM node across the non-editing -> editing switch (regression)', () => {
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    openCoordinateOperation(container);
    const scaleLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'Scale');
    const row = scaleLabel?.parentElement;
    assert.ok(row);
    click(row);
    // The SAME captured `row` reference must still be attached to the
    // document and must contain the editor: if the outer element had
    // swapped host type (e.g. div -> button) on entering edit mode, React
    // would have unmounted it and this reference would now be detached.
    assert.ok(container.contains(row), 'the row element captured before the click is still in the document');
    assert.ok(row.querySelector('input'), 'the same row element now contains the editor');
  });

  it('the select-type row (MapUnit) is reachable by getByRole(..., { name }) once opened', () => {
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: { ...PROJECTED_CRS, mapUnit: 'METRE' }, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Projected CRS'));
    assert.ok(trigger);
    click(trigger);
    const mapUnitLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'MapUnit');
    assert.ok(mapUnitLabel?.parentElement);
    click(mapUnitLabel.parentElement);
    const select = getByRoleTextbox(container, 'MapUnit');
    assert.equal(select.tagName, 'SELECT');
  });

  it('the "heights are ellipsoidal" Checkbox is reachable by getByLabelText', () => {
    useViewerStore.setState({
      cesiumEnabled: true,
      cesiumSourceModelId: 'A',
      cesiumTerrainHeight: 10,
      cesiumTerrainSaveHeight: 10,
    });
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    const checkbox = getByLabelText(container, 'Heights are ellipsoidal');
    assert.equal(checkbox.tagName, 'INPUT');
    assert.equal((checkbox as HTMLInputElement).type, 'checkbox');
  });
});
