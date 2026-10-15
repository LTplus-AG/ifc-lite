/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The LandXML georeferencing-assumption refusal prompt (#5048 relaxations):
 * the viewer never assumes a height system or reads an EPSG code from a name
 * on its own. The prompt offers only what the loader said would align the
 * file, retries with exactly what the user left checked, persists only on
 * "Always assume this", and Cancel assumes nothing.
 *
 * Mounted through the same slot `ViewportContainer` renders, beside the
 * HUD host it portals into. Dynamic import + try/catch (not a static one):
 * with the production change reverted the slot module does not exist, and
 * the assertions below must fail on their own merits rather than the file
 * failing to load (see `ViewportContainer.i18n.test.tsx`).
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { act, type ComponentType } from 'react';
import { useViewerStore } from '@/store';
import { render, cleanup, click, waitFor } from '@/test/render';
import { ViewportHud } from '../viewport-ui/hud/ViewportHud.js';

// Type-only: erased at runtime, so the file still loads with the change reverted.
import type { LandXmlGeorefAssumption, LandXmlGeorefAssumptions as Assumptions } from '@/hooks/ingest/landXmlGeorefAssumptions';

type Offer = readonly LandXmlGeorefAssumption[];

let Slot: ComponentType | undefined;
try {
  ({ LandXmlAssumptionRefusalPromptSlot: Slot } = await import('./LandXmlGeorefAssumptionsLazy.js'));
} catch {
  Slot = undefined;
}

const initialState = useViewerStore.getState();
const STORAGE_KEY = 'ifclite.landxml.georef-assumptions.v1';

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
  localStorage.removeItem(STORAGE_KEY);
});

const MESSAGE = 'LandXML "terrain.xml" cannot be aligned: it declares no vertical datum.';

function publish(offer: Offer, retries: Assumptions[], fileName = 'terrain.xml'): void {
  act(() => {
    useViewerStore.setState({
      landXmlAssumptionRefusal: { fileName, message: MESSAGE, offer, retry: (choice) => { retries.push(choice); } },
    });
  });
}

async function renderPrompt(): Promise<void> {
  assert.ok(Slot, 'the viewport mounts a LandXML assumption refusal prompt');
  const Mounted = Slot;
  render(<><ViewportHud /><Mounted /></>);
}

async function prompt(): Promise<HTMLElement> {
  await waitFor(() => document.querySelector('[role="alert"]') !== null, 'the refusal prompt to appear', 3000);
  return document.querySelector<HTMLElement>('[role="alert"]')!;
}

function checkboxes(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function button(name: RegExp): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => name.test(b.textContent ?? ''));
  assert.ok(found, `a button named ${name}`);
  return found;
}

describe('LandXmlAssumptionRefusalPrompt', () => {
  it('renders nothing until a refusal with an offer is published', async () => {
    await renderPrompt();
    assert.equal(document.querySelector('[role="alert"]'), null);
    publish([], []);
    assert.equal(document.querySelector('[role="alert"]'), null, 'an empty offer has nothing to choose');
  });

  it('shows the loader message verbatim and one pre-checked box per OFFERED assumption only', async () => {
    await renderPrompt();
    publish(['sharedVerticalDatum'], []);
    const alert = await prompt();
    assert.match(alert.textContent ?? '', /terrain\.xml/);
    assert.ok(alert.textContent?.includes(MESSAGE), 'what is missing, as the loader worded it');
    const boxes = checkboxes();
    assert.equal(boxes.length, 1, 'the EPSG-from-name assumption was not offered, so it is not shown');
    assert.equal(boxes[0].checked, true);
    assert.equal(document.activeElement, boxes[0], 'focus moves to the decision the load now waits on');
    assert.match(alert.textContent ?? '', /height system/i, 'the assumption is explained in words');
    assert.doesNotMatch(alert.textContent ?? '', /EPSG code from the coordinate system name/i);
  });

  it('"Load with these assumptions" retries with exactly the checked ones, every other one off, and persists nothing', async () => {
    const retries: Assumptions[] = [];
    await renderPrompt();
    publish(['sharedVerticalDatum', 'epsgFromName'], retries);
    await prompt();
    const unchecked = checkboxes().find((box) => box.dataset.assumption === 'epsgFromName');
    assert.ok(unchecked);
    click(unchecked);
    click(button(/^Load with these assumptions$/));
    assert.deepEqual(retries, [{ sharedVerticalDatum: true, epsgFromName: false }]);
    assert.equal(useViewerStore.getState().landXmlAssumptionRefusal, null, 'the prompt closes');
    assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, { sharedVerticalDatum: false, epsgFromName: false });
    assert.equal(localStorage.getItem(STORAGE_KEY), null);
  });

  it('cannot load with nothing checked', async () => {
    const retries: Assumptions[] = [];
    await renderPrompt();
    publish(['epsgFromName'], retries);
    await prompt();
    click(checkboxes()[0]);
    assert.equal(button(/^Load with these assumptions$/).disabled, true);
    assert.equal(button(/^Always assume this$/).disabled, true);
    assert.deepEqual(retries, []);
  });

  it('"Always assume this" turns the checked ones on in Settings, then retries with them', async () => {
    const retries: Assumptions[] = [];
    await renderPrompt();
    publish(['epsgFromName'], retries);
    await prompt();
    click(button(/^Always assume this$/));
    assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, { sharedVerticalDatum: false, epsgFromName: true });
    assert.deepEqual(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null'), { sharedVerticalDatum: false, epsgFromName: true });
    assert.deepEqual(retries, [{ sharedVerticalDatum: false, epsgFromName: true }]);
  });

  it('Cancel clears the refusal without retrying or persisting', async () => {
    const retries: Assumptions[] = [];
    await renderPrompt();
    publish(['sharedVerticalDatum'], retries);
    await prompt();
    click(button(/^Cancel$/));
    assert.equal(useViewerStore.getState().landXmlAssumptionRefusal, null);
    assert.deepEqual(retries, []);
    assert.deepEqual(useViewerStore.getState().landXmlGeorefAssumptionSettings, { sharedVerticalDatum: false, epsgFromName: false });
  });

  it('a box unchecked for one file is checked again when the next file refuses', async () => {
    await renderPrompt();
    publish(['sharedVerticalDatum'], [], 'a.xml');
    await prompt();
    click(checkboxes()[0]);
    assert.equal(checkboxes()[0].checked, false);
    publish(['sharedVerticalDatum'], [], 'b.xml');
    await waitFor(() => /b\.xml/.test(document.querySelector('[role="alert"]')?.textContent ?? ''), 'the second refusal', 3000);
    assert.equal(checkboxes()[0].checked, true, 'each file starts from its own offer');
  });
});
