/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10659: the georeferencing check's IfcSite RefLatitude / RefLongitude /
 * RefElevation fix, and the panel's site rows, written as positional
 * attribute edits in the SDK's `bim.georef.setSite` encoding. Through the real
 * parser, the SDK doctor, the viewer store and IFC export.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { readSiteValues } from '@ifc-lite/sdk/georef-doctor';
import { advance, cleanup, click, press, render, settle, type } from '@/test/render.js';
import { georefCheckFixture as fixture, parseIfcBytes as parse, seedGeorefModel as seed } from '@/test/georef-check-fixture.js';
import { useViewerStore } from '@/store';
import { exportModelStep } from '@/lib/export/model-step-export';
import { GeoreferencingPanel } from './GeoreferencingPanel';

const initialState = useViewerStore.getState();
const SITE = 11; // #11=IFCSITE in site-default-revit-boston.ifc
const BOSTON = { RefLatitude: 42 + 21 / 60 + 30.24 / 3600, RefLongitude: -(71 + 3 / 60 + 35.28 / 3600) };

afterEach(() => {
  cleanup();
  // The store's editor and view maps are filled in place, so a reset to `initialState` alone keeps this test's editor.
  useViewerStore.setState({ ...initialState, mutationViews: new Map(), storeEditors: new Map() }, true);
});

/** A fixture (default: the Revit default site position) with an LV95 map position (Bern) entered in the panel. */
async function bostonWithLv95(name = 'site-default-revit-boston'): Promise<IfcDataStore> {
  const store = await fixture(name);
  seed(store);
  useViewerStore.setState({
    georefMutations: new Map([['m', {
      projectedCRS: { name: 'EPSG:2056', mapUnit: 'METRE', verticalDatum: 'EPSG:5728' },
      mapConversion: { eastings: 2_600_000, northings: 1_199_650, orthogonalHeight: 540 },
    }]]),
  });
  return store;
}

function panel(store: IfcDataStore, editable = true): HTMLElement {
  return render(<GeoreferencingPanel georef={extractGeoreferencingOnDemand(store)} schemaVersion="IFC4" modelId="m" enableEditing={editable} lengthUnitScale={1} />);
}

async function settled(host: HTMLElement): Promise<string> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const summary = host.querySelector('[data-testid="georef-check-summary"]')?.textContent ?? '';
    if (summary && summary !== 'Checking…') return summary;
    await advance(25);
  }
  assert.fail('the georeferencing check did not finish');
}

function buttonContaining(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
}

/** The finding codes listed, in order (strings only: never a DOM node in an assertion message). */
function codes(host: HTMLElement): string[] {
  return [...host.querySelectorAll('[data-finding-code]')].map((row) => row.getAttribute('data-finding-code') ?? '');
}

const view = () => useViewerStore.getState().mutationViews.get('m') ?? null;
const siteValues = (store: IfcDataStore) => readSiteValues(store, view(), SITE);

it('applies the site location fix as one undo step, re-checks, and exports it (#10659)', async () => {
  const store = await bostonWithLv95();
  const host = panel(store);
  await settled(host);
  const toggle = buttonContaining(host, 'Georeferencing check');
  assert.ok(toggle, 'the check header renders');
  click(toggle);
  assert.ok(codes(host).includes('SITE_LOCATION_DEFAULT'), `listed: ${codes(host).join(', ')}`);
  const row = host.querySelector('[data-finding-code="SITE_LOCATION_DEFAULT"]');
  const apply = row ? [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Apply fix') : undefined;
  assert.ok(apply, 'the site fix offers Apply fix');
  click(apply);

  // Written in the SDK's encoding: [deg, min, sec, millionths], one sign, at IfcSite positions 9 and 10; RefElevation a REAL.
  const edits = view()?.getPositionalMutationsForEntity(SITE);
  const latitude = edits?.get(9), longitude = edits?.get(10);
  assert.ok(Array.isArray(latitude) && latitude.length === 4 && latitude.every((c) => Number.isInteger(c) && Number(c) >= 0), `RefLatitude ${JSON.stringify(latitude)}`);
  assert.ok(Array.isArray(longitude) && longitude.length === 4 && longitude.every((c) => Number.isInteger(c) && Number(c) >= 0), `RefLongitude ${JSON.stringify(longitude)}`);
  assert.deepEqual(latitude.slice(0, 2), [46, 56], 'Bern, 46°56′N');
  assert.deepEqual(longitude.slice(0, 2), [7, 26], 'Bern, 7°26′E');
  assert.deepEqual(edits?.get(11), { real: 540 }, 'RefElevation from the stated vertical datum');
  const fixed = siteValues(store);
  assert.ok(Math.abs((fixed.RefLatitude ?? 0) - 46.9479) < 1e-3 && Math.abs((fixed.RefLongitude ?? 0) - 7.4386) < 1e-3, JSON.stringify(fixed));

  await settle();
  assert.equal(await settled(host), 'No problems found', `the finding clears once the edit is checked; listed: ${codes(host).join(', ')}`);

  const result = await exportModelStep({
    modelId: 'm', dataStore: store, mutationView: view() ?? undefined,
    options: { schema: 'IFC4', applyMutations: true, georefMutations: useViewerStore.getState().georefMutations.get('m') },
    scheduleState: null,
  });
  const text = typeof result.content === 'string' ? result.content : new TextDecoder().decode(result.content);
  assert.match(text, new RegExp(`IFCSITE\\([^;]*\\(${latitude.join(',')}\\),\\(${longitude.join(',')}\\),540\\.`), 'the exported IfcSite carries the fix');
  const saved = readSiteValues(await parse(new TextEncoder().encode(text)), null, SITE);
  assert.deepEqual(saved, fixed, 'and reads back as written');

  act(() => useViewerStore.getState().undo('m'));
  await settle();
  assert.equal(view()?.getPositionalMutationsForEntity(SITE)?.size ?? 0, 0, 'one undo removes all three site edits');
  const undone = siteValues(store);
  assert.ok(Math.abs((undone.RefLatitude ?? 0) - BOSTON.RefLatitude) < 1e-9 && Math.abs((undone.RefLongitude ?? 0) - BOSTON.RefLongitude) < 1e-9, JSON.stringify(undone));
  assert.equal(undone.RefElevation, null);
  await settled(host);
  assert.ok(codes(host).includes('SITE_LOCATION_DEFAULT'), 'the finding is back after undo');

  act(() => useViewerStore.getState().redo('m'));
  assert.deepEqual(siteValues(store), fixed, 'redo writes it again');
});

function editRow(host: HTMLElement, attribute: string, value: string): void {
  const cell = host.querySelector<HTMLButtonElement>(`button[aria-label^="${attribute}:"]`);
  assert.ok(cell, `${attribute} is editable`);
  click(cell);
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${attribute}"]`);
  assert.ok(input, `${attribute} opens an input`);
  type(input, value);
  press(input, 'Enter');
}

it('edits the site latitude in the panel as one undoable write (#10659)', async () => {
  const store = await bostonWithLv95();
  const host = panel(store);
  await settled(host);
  const header = buttonContaining(host, 'Site location (IfcSite)');
  assert.ok(header, 'the site section renders');
  assert.match(host.querySelector('[data-testid="georef-site-summary"]')?.textContent ?? '', /^42\.35\d*°, -71\.05\d*°$/);
  click(header);

  editRow(host, 'RefLatitude', '-33.5');
  assert.deepEqual(view()?.getPositionalMutationsForEntity(SITE)?.get(9), [-33, -30, 0, 0], 'a southern angle negates every component');
  assert.ok(Math.abs((siteValues(store).RefLongitude ?? 0) - BOSTON.RefLongitude) < 1e-9, 'RefLongitude is kept');

  act(() => useViewerStore.getState().undo('m'));
  assert.equal(view()?.getPositionalMutationsForEntity(SITE)?.size ?? 0, 0, 'undo takes the row edit back');
});

it('holds one coordinate of a site without a location until the other is entered (#10659)', async () => {
  const store = await bostonWithLv95('no-georef');
  const siteId = store.entityIndex.byType.get('IFCSITE')?.[0];
  assert.ok(siteId !== undefined, 'the fixture has an IfcSite');
  const host = panel(store);
  await settled(host);
  const header = buttonContaining(host, 'Site location (IfcSite)');
  assert.ok(header, 'the site section renders');
  click(header);

  editRow(host, 'RefLatitude', '46.5');
  assert.equal(view()?.getPositionalMutationsForEntity(siteId)?.size ?? 0, 0, 'a latitude alone is not written');
  editRow(host, 'RefLongitude', '7.25');
  const edits = view()?.getPositionalMutationsForEntity(siteId);
  assert.deepEqual([edits?.get(9), edits?.get(10)], [[46, 30, 0, 0], [7, 15, 0, 0]], 'both are written together');

  act(() => useViewerStore.getState().undo('m'));
  assert.equal(view()?.getPositionalMutationsForEntity(siteId)?.size ?? 0, 0, 'as one undo step');
});

it('shows no site rows or site fix in a read-only panel (#10659)', async () => {
  const store = await bostonWithLv95();
  const host = panel(store, false);
  await settled(host);
  const header = buttonContaining(host, 'Site location (IfcSite)');
  assert.ok(header, 'the site section renders read-only');
  click(header);
  assert.equal(host.querySelector('button[aria-label^="RefLatitude:"]') === null, true, 'the rows are not editable');
  assert.equal(buttonContaining(host, 'Apply fix') === undefined, true, 'and no fix is offered');
});
