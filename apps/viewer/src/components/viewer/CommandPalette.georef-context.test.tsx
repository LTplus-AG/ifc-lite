/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { installLayout } from '@/test/dom-layout';
installLayout();
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import { cleanup, click, advance, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { mountDestinations, searchDestination, destinationOption, namedButton } from '@/test/palette-destinations';
import { useViewerStore } from '@/store';
import { publishPlacementGeorefContext } from '@/lib/geo/placement-georef-runtime';
import { CesiumPlacementGizmo } from './placement/CesiumPlacementGizmo';
import { PlacementPanel } from './placement/PlacementPanel';

const conversion: MapConversion = { id: 1, sourceCRS: 2, targetCRS: 3,
  eastings: 500000, northings: 5200000, orthogonalHeight: 10, scale: 1 };
const projected: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };
const initial = useViewerStore.getState();
const hosts: ReturnType<typeof mountDestinations>[] = [];
beforeEach(() => {
  localStorage.clear();
  useViewerStore.setState({ ...fixtureModels(fixtureModel('geo')), collabRole: null,
    cesiumEnabled: false, cesiumAvailable: false, cesiumPlacementEditMode: false,
    cesiumPlacementDraft: null, cesiumPlacementDraftModelId: null, repositionOpen: false });
});
afterEach(async () => {
  cleanup(); for (const host of hosts.splice(0)) await host.dispose();
  publishPlacementGeorefContext(null); useViewerStore.setState(initial); localStorage.clear();
});
function Bodies({ base = conversion, crs = projected }: { base?: MapConversion; crs?: ProjectedCRS }) {
  const [currentCRS, setCRS] = useState(crs);
  const panel = useViewerStore(s => s.sidebarActivePanel);
  return <>
    <button onClick={() => setCRS({ id: 3, name: 'EPSG:4326' })}>Use geographic CRS</button>
    <CesiumPlacementGizmo modelId="geo" mapConversion={base} baseMapConversion={base} projectedCRS={currentCRS} />
    {panel === 'placement' && <PlacementPanel />}
  </>;
}
const row = () => destinationOption('view:move-georef');

test('#8947 Move georef follows real projected capability without requiring World and opens actual editor', async () => {
  hosts.push(mountDestinations(<Bodies />)); searchDestination('move georef');
  await waitFor(() => row().getAttribute('aria-disabled') !== 'true', 'actual projection resolves');
  click(row()); await advance(60);
  assert.equal(useViewerStore.getState().cesiumEnabled, false);
  assert.equal(document.querySelector('[role="tab"][data-state="active"]')?.textContent, 'Georeference');
  await waitFor(() => Boolean(document.querySelector('[aria-label="Nudge east"]')), 'actual controller exposes metre controls');
});

for (const kind of ['rigid', 'wkt', 'geographic'] as const)
  test(`#8947 ${kind} georeference never advertises an executable move action`, async () => {
    useViewerStore.setState({ cesiumEnabled: true, cesiumAvailable: true });
    const base: MapConversion = kind === 'rigid' ? { ...conversion, operation: 'rigidOperation' } : conversion;
    const crs = kind === 'wkt' ? { ...projected, wellKnownText: 'GEOGCRS["fixture"]' }
      : kind === 'geographic' ? { id: 3, name: 'EPSG:4326' } : projected;
    hosts.push(mountDestinations(<Bodies base={base} crs={crs} />)); searchDestination('move georef');
    await advance(60);
    assert.equal(row().getAttribute('aria-disabled'), 'true');
    assert.ok(row().getAttribute('aria-describedby'));
    click(row()); await advance(30);
    assert.equal(useViewerStore.getState().cesiumPlacementEditMode, false);
    assert.ok(document.querySelector('[role="combobox"]'));
  });

test('#8947 live CRS and role changes update georeference availability before activation', async () => {
  hosts.push(mountDestinations(<Bodies />)); searchDestination('move georef');
  await waitFor(() => row().getAttribute('aria-disabled') !== 'true', 'projected capability');
  act(() => useViewerStore.setState({ collabRole: 'viewer' }));
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  act(() => useViewerStore.setState({ collabRole: null }));
  click(namedButton('Use geographic CRS')); await advance(60);
  assert.equal(row().getAttribute('aria-disabled'), 'true');
  assert.match(row().textContent ?? '', /projected CRS/);
  click(row()); await advance(30);
  assert.equal(useViewerStore.getState().cesiumPlacementEditMode, false);
});
