/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10603: the Site context and Surface runoff commands reach their sections,
 * and the sections say what a model still needs instead of vanishing.
 *
 * - The command opened nothing on desktop (it un-collapsed a panel the desktop
 *   sidebar does not read) and left the section at the bottom of the panel.
 * - A model with no georeferencing rendered the "Add georeferencing" row
 *   alone: the Site context section the command pointed at did not exist.
 * - Adding georeferencing sets the position to 0/0, outside Switzerland, and
 *   the section then disappeared without a word.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import type { MapConversion } from '@ifc-lite/parser';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture';
import { render, cleanup, waitFor } from '@/test/render';
import { resetFeaturesForTest } from '@/lib/features';
import { spatialReferenceFromIfc } from '@/lib/geo/ifc-spatial-reference';
import { openFloodCheck, openSiteContext } from '@/lib/site-context/site-context-command';
import { GEOREF_FOCUS_ATTRIBUTE, pendingGeorefSectionFocus, requestGeorefSectionFocus } from '@/lib/site-context/georef-section-focus';
import { GeoreferencingPanel } from '../properties/GeoreferencingPanel';
import { SiteContextSection } from './SiteContextSection';
import { FloodCheckSection } from './FloodCheckSection';

const FRAME: CoordinateInfo = {
  originShift: { x: 0, y: 0, z: 0 },
  originalBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  shiftedBounds: { min: { x: -5, y: 0, z: -5 }, max: { x: 5, y: 10, z: 5 } },
  hasLargeCoordinates: false,
};

/** An IFC model placed at (eastings, northings) in LV95, or with no georeferencing when `at` is null. */
function model(id: string, at: { eastings: number; northings: number } | null): FederatedModel {
  const base = fixtureModel(id) as FederatedModel;
  if (!at) return { ...base, geometryResult: { meshes: [], coordinateInfo: FRAME } } as unknown as FederatedModel;
  const mapConversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3, ...at, orthogonalHeight: 500 };
  const spatialReference = spatialReferenceFromIfc({ mapConversion, projectedCRS: { id: 3, name: 'EPSG:2056', mapUnitScale: 1, verticalDatum: 'LN02' }, lengthUnitScale: 1, coordinateInfo: FRAME });
  return { ...base, loadedAt: 1, spatialReference, geometryResult: { meshes: [], coordinateInfo: FRAME } } as unknown as FederatedModel;
}

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); resetFeaturesForTest(); useViewerStore.setState(initial, true); });

test('the command shows the Information panel on the model even when another panel holds the slot', () => {
  useViewerStore.setState({ models: new Map([['m', model('m', null)]]), selectedModelId: null });
  useViewerStore.getState().showWorkspacePanel('clash');
  useViewerStore.getState().setSidebarMode('collapsed');
  openSiteContext('palette');
  const state = useViewerStore.getState();
  assert.equal(state.selectedModelId, 'm');
  assert.equal(state.sidebarActivePanel, 'properties');
  assert.equal(state.sidebarMode, 'expanded');
  assert.equal(state.clashPanelVisible, false);
  assert.deepEqual(pendingGeorefSectionFocus() && { ...pendingGeorefSectionFocus(), at: 0 }, { modelId: 'm', section: 'siteContext', at: 0 });
  openFloodCheck('ribbon');
  assert.equal(pendingGeorefSectionFocus()?.section, 'floodCheck');
});

test('a model with no georeferencing shows the add row and a Site context section that says what to do', async () => {
  useViewerStore.setState({ models: new Map([['m', model('m', null)]]) });
  const host = render(<GeoreferencingPanel georef={null} modelId="m" enableEditing schemaVersion="IFC4" />);
  await waitFor(() => host.querySelector('[data-testid="site-context-refusal"]') !== null, 'the site-context refusal');
  assert.ok([...host.querySelectorAll('button')].some((b) => /add georeferencing/i.test(b.textContent ?? '')));
  assert.equal(host.querySelector('[data-testid="site-context-refusal"]')?.getAttribute('data-reason'), 'not-georeferenced');
  assert.match(host.textContent ?? '', /EPSG:2056/);
});

test('a read-only model with no georeferencing still says why site context cannot load, without an add hint', async () => {
  useViewerStore.setState({ models: new Map([['m', model('m', null)]]) });
  const host = render(<GeoreferencingPanel georef={null} modelId="m" enableEditing={false} schemaVersion="IFC4" />);
  await waitFor(() => host.querySelector('[data-testid="site-context-refusal"]') !== null, 'the site-context refusal');
  assert.equal([...host.querySelectorAll('button')].some((b) => /add georeferencing/i.test(b.textContent ?? '')), false);
  assert.doesNotMatch(host.textContent ?? '', /EPSG:2056/);
});

test('a model georeferenced at 0/0 (just added) explains the Swiss-only scope instead of hiding the section', async () => {
  useViewerStore.setState({ models: new Map([['m', model('m', { eastings: 0, northings: 0 })]]) });
  const host = render(<SiteContextSection modelId="m" editable />);
  await waitFor(() => host.querySelector('[data-testid="site-context-refusal"]') !== null, 'the refusal');
  assert.equal(host.querySelector('[data-testid="site-context-refusal"]')?.getAttribute('data-reason'), 'outside-switzerland');
  assert.match(host.textContent ?? '', /set its position on the map/);
});

test('a requested section scrolls into view, highlights and consumes the request', async () => {
  // No data store, as in SiteContextSection.anchor.test.tsx: the anchor then reads only the spatial reference.
  useViewerStore.setState({ models: new Map([['m', { ...model('m', { eastings: 2_600_000, northings: 1_200_000 }), ifcDataStore: undefined } as unknown as FederatedModel]]) });
  requestGeorefSectionFocus('m', 'siteContext');
  const host = render(<SiteContextSection modelId="m" editable />);
  await waitFor(() => host.querySelector('[data-testid="site-context-section"]') !== null, 'the section');
  await waitFor(() => pendingGeorefSectionFocus() === null, 'request consumed');
  assert.equal(host.querySelector('[data-testid="site-context-section"]')?.hasAttribute(GEOREF_FOCUS_ATTRIBUTE), true);
});

test('Surface runoff stays quiet on a model it cannot check, but explains itself when asked for', async () => {
  useViewerStore.setState({ models: new Map([['m', model('m', null)]]) });
  const quiet = render(<FloodCheckSection modelId="m" />);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(quiet.querySelector('[data-testid="flood-check-section"]'), null);
  cleanup();
  requestGeorefSectionFocus('m', 'floodCheck');
  const asked = render(<FloodCheckSection modelId="m" />);
  await waitFor(() => asked.querySelector('[data-testid="flood-check-unavailable"]') !== null, 'the explanation');
  await waitFor(() => pendingGeorefSectionFocus() === null, 'request consumed');
});

test('a host that switched third-party services off gets no site-context or runoff section (#10603)', async () => {
  resetFeaturesForTest({ default: 'all', disable: ['privacy.third-party'] });
  useViewerStore.setState({ models: new Map([['m', model('m', { eastings: 2_600_000, northings: 1_200_000 })]]) });
  const host = render(<><SiteContextSection modelId="m" editable /><FloodCheckSection modelId="m" /></>);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(host.querySelector('[data-testid="site-context-section"]'), null);
  assert.equal(host.querySelector('[data-testid="flood-check-section"]'), null);
});
