/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `GeoreferencingPanel` labelling (#5812): every editable field's inline
 * `<input>`/`<select>` is reachable by `getByRole(..., { name })`, and the
 * "heights are ellipsoidal" checkbox (now the `Checkbox` primitive) is
 * reachable by `getByLabelText`. Also covers:
 * - the row's `<div>` staying a single, stable DOM node across the
 *   non-editing/editing switch — a regression this PR introduced and fixed
 *   (see `georef-rows.tsx`): swapping the row's host element type on
 *   entering `editing` made React remount it, detaching any element
 *   reference captured before the click that opens it;
 * - the row `<div>` never being `role="button"` itself, even when it
 *   renders a real nested `<button>` (`TerrainHeightButton`, on the
 *   OrthogonalHeight row with Cesium terrain active) — a second regression
 *   caught in review: a `role="button"` row around a real `<button>` nests
 *   one interactive element inside another.
 */
import '@/test/setup-dom.js';
import { afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render, click } from '@/test/render.js';
import { useViewerStore } from '@/store';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { GeoreferencingPanel } from './GeoreferencingPanel.js';

// Two tests below set Cesium terrain fields on the global store; restore the
// snapshot from before this file ran so they don't leak into later files.
let initialState: ReturnType<typeof useViewerStore.getState>;

before(() => {
  initialState = useViewerStore.getState();
});

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
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

function getByRoleButtonName(container: ParentNode, name: string): HTMLElement {
  const match = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name);
  assert.ok(match, `no <button> with accessible name "${name}"`);
  return match;
}

function openCoordinateOperation(container: HTMLElement): void {
  const trigger = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Coordinate Operation'));
  assert.ok(trigger, 'Coordinate Operation trigger must render');
  click(trigger);
}

/** The row `<div>` is never interactive; its value-cell `<button>` (inside it) is. */
function clickRow(rowEl: ParentNode): void {
  const button = rowEl.querySelector('button');
  assert.ok(button, 'row value-cell button must render to start editing');
  click(button);
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
    assert.equal(row.getAttribute('role'), null, 'the row div itself is never interactive');
    const valueButton = row.querySelector('button');
    assert.equal(valueButton?.getAttribute('aria-label'), 'Scale: 1');
    clickRow(row);
    const input = getByRoleTextbox(container, 'Scale');
    assert.equal(input, row.querySelector('input'), 'the labelled control is the one this same row now shows');
    const helpId = input.getAttribute('aria-describedby');
    assert.ok(helpId, 'Scale guidance is associated with its input');
    assert.ok(document.getElementById(helpId)?.textContent, 'the description target contains guidance');
    const cancel = [...row.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('Cancel'));
    assert.ok(cancel);
    click(cancel);
    const restoredValueButton = row.querySelector('button[aria-label="Scale: 1"]');
    assert.ok(restoredValueButton, 'the value control renders again after editing');
    assert.ok(document.activeElement === restoredValueButton, 'focus returns to the field value after editing');
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
    clickRow(row);
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
    clickRow(mapUnitLabel.parentElement);
    const select = getByRoleTextbox(container, 'MapUnit');
    assert.equal(select.tagName, 'SELECT');
  });

  it('names the angle value and restores focus after its editor closes', () => {
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    openCoordinateOperation(container);
    const label = [...container.querySelectorAll('span')].find((span) => span.textContent?.endsWith('Angle to Grid North'));
    assert.ok(label?.parentElement);
    const row = label.parentElement;
    const valueButton = row.querySelector('button[aria-label]');
    assert.match(valueButton?.getAttribute('aria-label') ?? '', /^Angle to Grid North: /);
    assert.ok(valueButton);
    click(valueButton);
    const input = getByRoleTextbox(row, 'Angle to Grid North');
    const noteId = input.getAttribute('aria-describedby');
    assert.ok(noteId);
    assert.match(document.getElementById(noteId)?.textContent ?? '', /XAxisAbscissa/);
    const cancel = [...row.querySelectorAll('button')].find((button) => button.getAttribute('aria-label')?.includes('Cancel'));
    assert.ok(cancel);
    click(cancel);
    const restoredValueButton = row.querySelector('button[aria-label]');
    assert.ok(restoredValueButton, 'the angle value control renders again after editing');
    assert.ok(document.activeElement === restoredValueButton, 'focus returns to the angle value after editing');
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

  it('OrthogonalHeight row with an active Cesium terrain button nests no interactive element inside another (regression)', () => {
    // Reviewer's exact repro: Cesium terrain ready AND this model is the
    // active Cesium source, so `TerrainHeightButton` (a real <button>)
    // renders as this row's `children` — inside the same row `<div>` the
    // click-to-edit affordance lives in.
    useViewerStore.setState({
      cesiumEnabled: true,
      cesiumSourceModelId: 'A',
      cesiumTerrainHeight: 42.5,
      cesiumTerrainSaveHeight: 40.1,
    });
    const container = render(
      <GeoreferencingPanel
        georef={{ hasGeoreference: true, mapConversion: MAP_CONVERSION, projectedCRS: PROJECTED_CRS, source: 'mapConversion' }}
        schemaVersion="IFC4"
        modelId="A"
        enableEditing
      />,
    );
    openCoordinateOperation(container);
    const heightLabel = [...container.querySelectorAll('span')].find((span) => span.textContent === 'OrthogonalHeight');
    assert.ok(heightLabel?.parentElement, 'OrthogonalHeight row renders');
    const row = heightLabel.parentElement as HTMLElement;

    // The row itself must never be an interactive element...
    assert.equal(row.getAttribute('role'), null, 'the row div is not role="button"');
    assert.equal(row.tagName, 'DIV');

    // ...and DOM structure must have no nested interactive elements: no
    // <button> (or role="button") is itself inside another <button>/
    // role="button" anywhere in this row.
    for (const interactive of row.querySelectorAll('button, [role="button"]')) {
      const ancestorInteractive = interactive.parentElement?.closest('button, [role="button"]');
      assert.equal(ancestorInteractive, null, `${interactive.outerHTML} must not nest inside another interactive element`);
    }

    // Both the edit-value trigger and the terrain button are still
    // separately reachable by getByRole('button', { name }).
    const editButton = getByRoleButtonName(row, 'OrthogonalHeight: 12m');
    assert.ok(editButton);
    const terrainButton = getByRoleButtonName(row, '42.5 m');
    assert.ok(terrainButton);
    assert.notEqual(editButton, terrainButton);
  });
});
