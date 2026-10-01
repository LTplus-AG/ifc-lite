/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, type, advance, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';

async function projectionSettings() {
  // Production revert removes this new module. Assert its absence inside a
  // test so the oracle records a regression instead of a file-load failure.
  const module = await import('./DrawingProjectionSettings').catch(() => null);
  assert.ok(module, 'manual projection controls must be available');
  return module.DrawingProjectionSettings;
}

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
async function open(unit = 'm') {
  const DrawingProjectionSettings = await projectionSettings();
  useViewerStore.setState({ unitDisplayOverrides: { LENGTHUNIT: unit },
    drawing2DDisplayOptions: { ...initial.drawing2DDisplayOptions, constructionProjectionDepth: null } });
  const ui = render(<DrawingProjectionSettings available />);
  const trigger = ui.querySelector<HTMLButtonElement>('button[aria-label="Projection settings"]'); assert.ok(trigger);
  click(trigger); await advance(0);
  const popup = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Projection settings"]'); assert.ok(popup);
  return popup;
}
function checkbox(popup: HTMLElement) {
  const control = popup.querySelector<HTMLInputElement>('input[type="checkbox"]'); assert.ok(control); return control;
}
function distance(popup: HTMLElement) {
  const input = popup.querySelector<HTMLInputElement>('input[type="number"]'); assert.ok(input); return input;
}

test('projection settings switch Auto/manual and accept zero as cut-only depth (#6615)', async () => {
  const popup = await open();
  assert.equal(checkbox(popup).checked, true);
  assert.equal(popup.querySelector('input[type="number"]'), null);
  click(checkbox(popup));
  assert.equal(distance(popup).value, '3');
  type(distance(popup), '0');
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.constructionProjectionDepth, 0);
  assert.equal(distance(popup).getAttribute('aria-invalid'), 'false', 'zero is a valid cut-only band');
  click(checkbox(popup));
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.constructionProjectionDepth, null);
  assert.equal(popup.querySelector('input[type="number"]'), null, 'Auto removes the manual distance');
});

for (const [unit, display, metres] of [['mm', '2500', 2.5], ['cm', '125', 1.25], ['ft', '10', 3.048]] as const) {
  test(`projection distance uses ${unit} display and canonical metre storage (#6615)`, async () => {
    const popup = await open(unit); click(checkbox(popup));
    assert.equal(distance(popup).getAttribute('aria-label'), `Depth (${unit})`);
    type(distance(popup), display);
    assert.ok(Math.abs(useViewerStore.getState().drawing2DDisplayOptions.constructionProjectionDepth! - metres) < 1e-10);
    act(() => useViewerStore.setState({ unitDisplayOverrides: { LENGTHUNIT: 'm' } }));
    assert.equal(distance(popup).getAttribute('aria-label'), 'Depth (m)');
    assert.ok(Math.abs(Number(distance(popup).value) - metres) < 1e-10, 'changing display units preserves the physical depth');
  });
}

test('negative, empty and nonfinite edits show validation and retain the last valid depth (#6615)', async () => {
  const popup = await open(); click(checkbox(popup)); type(distance(popup), '2');
  for (const input of ['-1', '', '1e999']) {
    type(distance(popup), input);
    assert.equal(distance(popup).getAttribute('aria-invalid'), 'true');
    assert.match(popup.textContent!, /Enter a finite distance of zero or more/);
    assert.equal(useViewerStore.getState().drawing2DDisplayOptions.constructionProjectionDepth, 2);
  }
  type(distance(popup), '4');
  assert.equal(distance(popup).getAttribute('aria-invalid'), 'false');
  assert.equal(useViewerStore.getState().drawing2DDisplayOptions.constructionProjectionDepth, 4);
});

test('unavailable face-picked projection settings cannot be opened (#6615)', async () => {
  const DrawingProjectionSettings = await projectionSettings();
  const ui = render(<DrawingProjectionSettings available={false} />);
  const trigger = ui.querySelector<HTMLButtonElement>('button'); assert.ok(trigger);
  assert.equal(trigger.disabled, true);
  click(trigger);
  assert.equal(document.querySelector('[role="dialog"][aria-label="Projection settings"]'), null);
});

test('invalid runtime depths cannot switch the displayed manual band to Auto (#6615)', async () => {
  const popup = await open(); click(checkbox(popup)); type(distance(popup), '2');
  for (const constructionProjectionDepth of [-1, NaN, Infinity]) {
    act(() => useViewerStore.getState().updateDrawing2DDisplayOptions({ constructionProjectionDepth, showHiddenLines: true }));
    assert.equal(checkbox(popup).checked, false, 'the manual control remains active');
    assert.equal(distance(popup).value, '2', 'the displayed metric distance retains the valid band');
  }
});
