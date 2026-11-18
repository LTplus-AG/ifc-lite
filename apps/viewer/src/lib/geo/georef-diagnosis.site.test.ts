/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #10659 review: with several IfcSites the check reads the site the SDK reader picks, not the first edited one. */
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseIfcBytes, seedGeorefModel } from '@/test/georef-check-fixture.js';
import type { IfcAttributeValue } from '@ifc-lite/mutations';
import { useViewerStore } from '@/store';
import { editedSiteLocation } from './georef-diagnosis';

const initialState = useViewerStore.getState();
afterEach(() => useViewerStore.setState({ ...initialState, mutationViews: new Map(), storeEditors: new Map() }, true));

async function twoSites() {
  const text = readFileSync(new URL('../../../../../packages/georef-check/fixtures/site-default-revit-boston.ifc', import.meta.url), 'utf8')
    .replace(/(#11=IFCSITE[^\n]*\n)/, "$1#900=IFCSITE('0GeorefCheckSite000002',$,'Site B',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);\n");
  const store = await parseIfcBytes(new TextEncoder().encode(text));
  seedGeorefModel(store);
  return store;
}

const write = (id: number, lat: IfcAttributeValue, lon: IfcAttributeValue) =>
  useViewerStore.getState().setPositionalAttributesBatch('m', [{ entityId: id, index: 9, value: lat }, { entityId: id, index: 10, value: lon }]);
const view = () => useViewerStore.getState().mutationViews.get('m') ?? null;

it('keeps the first located site when a later site is given a location', async () => {
  const store = await twoSites();
  assert.equal(editedSiteLocation(store, view()), undefined, 'no edits: the file facts stand');
  write(900, [46, 30, 0, 0], [7, 15, 0, 0]);
  assert.equal(editedSiteLocation(store, view())?.siteId, 11);
});

it('falls through to the next located site when the first one is cleared', async () => {
  const store = await twoSites();
  write(900, [46, 30, 0, 0], [7, 15, 0, 0]);
  write(11, null, null);
  const location = editedSiteLocation(store, view());
  assert.equal(location?.siteId, 900);
  assert.equal(location?.latitude, 46.5);
});

it('reports no location once no site has both coordinates', async () => {
  const store = await twoSites();
  write(11, null, null);
  assert.equal(editedSiteLocation(store, view()), null);
});

it('falls through to the next located site when the first one is deleted', async () => {
  const store = await twoSites();
  write(900, [46, 30, 0, 0], [7, 15, 0, 0]);
  view()?.deleteEntity(11);
  assert.equal(editedSiteLocation(store, view())?.siteId, 900);
});
