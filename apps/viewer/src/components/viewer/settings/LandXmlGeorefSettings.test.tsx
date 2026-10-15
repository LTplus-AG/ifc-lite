/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Settings → General → LandXML georeferencing: the two #5048 relaxations a
 * user can opt into for every LandXML load. Both start off, each switch
 * turns on exactly its own assumption, and the choice is saved.
 *
 * Opened through the real Settings host (`SettingsDialogHost` +
 * `openSettings`), the way every opener reaches it.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act } from 'react';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { openSettings } from '@/lib/settings/open-settings';
import { useViewerStore } from '@/store';
import { SettingsDialogHost } from './SettingsDialog.js';

const STORAGE_KEY = 'ifclite.landxml.georef-assumptions.v1';
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
  localStorage.removeItem(STORAGE_KEY);
});

async function openGeneral(): Promise<HTMLElement> {
  render(<SettingsDialogHost />);
  act(() => openSettings('general'));
  const dialog = document.querySelector<HTMLElement>('[data-settings-dialog]');
  assert.ok(dialog);
  await waitFor(() => /LandXML georeferencing/.test(dialog.textContent ?? ''), 'the LandXML georeferencing group in Settings → General', 3000);
  return dialog;
}

function switchFor(dialog: HTMLElement, label: RegExp): HTMLElement {
  const labelEl = [...dialog.querySelectorAll('label')].find((candidate) => label.test(candidate.textContent ?? ''));
  assert.ok(labelEl, `a setting labelled ${label}`);
  const control = dialog.querySelector<HTMLElement>(`#${labelEl.htmlFor}`);
  assert.ok(control, `${label} labels its switch`);
  return control;
}

it('LandXML georeferencing assumptions are listed in Settings, off by default, with what each assumes', async () => {
  const dialog = await openGeneral();
  const text = dialog.textContent ?? '';
  assert.match(text, /off by default/i);
  assert.match(text, /too high or too low by the difference between the two height systems/);
  assert.match(text, /exactly "EPSG:" followed by a number/);
  assert.equal(switchFor(dialog, /shared height system/i).getAttribute('aria-checked'), 'false');
  assert.equal(switchFor(dialog, /EPSG code from the coordinate system name/i).getAttribute('aria-checked'), 'false');
});

it('each switch turns on exactly its own assumption and the choice is saved', async () => {
  const dialog = await openGeneral();
  click(switchFor(dialog, /shared height system/i));
  assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, { sharedVerticalDatum: true, epsgFromName: false });
  assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), { sharedVerticalDatum: true, epsgFromName: false });
  assert.equal(switchFor(dialog, /shared height system/i).getAttribute('aria-checked'), 'true');

  click(switchFor(dialog, /EPSG code from the coordinate system name/i));
  click(switchFor(dialog, /shared height system/i));
  assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, { sharedVerticalDatum: false, epsgFromName: true });
});

it('reflects a setting turned on elsewhere (the refusal prompt\'s "Always assume this")', async () => {
  const dialog = await openGeneral();
  act(() => useViewerStore.getState().setLandXmlGeorefAssumptionSettings({ epsgFromName: true }));
  assert.equal(switchFor(dialog, /EPSG code from the coordinate system name/i).getAttribute('aria-checked'), 'true');
  assert.equal(switchFor(dialog, /shared height system/i).getAttribute('aria-checked'), 'false');
});
