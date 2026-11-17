/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10608: the Georeference panel's georef-check diagnosis and the EPSG lookup's
 * area of use, through the real parser, the SDK doctor (offline CRS engine,
 * bundled EPSG catalogue) and the viewer store, over `@ifc-lite/georef-check`'s
 * committed fixtures. Everything is observed through the panel and the lookup
 * dialog as a user sees them.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { CoordinateInfo } from '@ifc-lite/geometry';
import { extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { advance, cleanup, click, render, type } from '@/test/render.js';
import { georefCheckFixture as fixture, parseIfcBytes as parse, seedGeorefModel as seed } from '@/test/georef-check-fixture.js';
import { useViewerStore } from '@/store';
import { exportModelStep } from '@/lib/export/model-step-export';
import { GeoreferencingPanel } from './GeoreferencingPanel';
import { EpsgLookupDialog } from './EpsgLookupDialog';

const initialState = useViewerStore.getState();
const AREA_OF_USE_2056 = /Area of use: longitude 5\.\d+° to 10\.\d+°, latitude 45\.\d+° to 47\.\d+°\./;

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

/** The fixtures are millimetre files in a metre CRS. */
function panel(store: IfcDataStore, { editable = true, coordinateInfo }: { editable?: boolean; coordinateInfo?: CoordinateInfo } = {}): HTMLElement {
  return render(
    <GeoreferencingPanel georef={extractGeoreferencingOnDemand(store)} schemaVersion="IFC4" modelId="m"
      enableEditing={editable} lengthUnitScale={0.001} coordinateInfo={coordinateInfo} />,
  );
}

/** Let the lazy diagnosis settle: poll until the summary is no longer "Checking…". */
async function settled(host: HTMLElement): Promise<string> {
  for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
    const summary = host.querySelector('[data-testid="georef-check-summary"]')?.textContent ?? '';
    if (summary && summary !== 'Checking…') return summary;
    await advance(25);
  }
  assert.fail('the georeferencing check did not finish');
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

function outsideAreaAlert(host: HTMLElement): Element | undefined {
  return [...host.querySelectorAll('[role="alert"]')].find((a) => a.textContent?.includes('Outside the area of use'));
}

function openList(host: HTMLElement): void {
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Georeferencing check'));
  assert.ok(toggle, 'the check header renders');
  click(toggle);
}

async function exported(store: IfcDataStore): Promise<IfcDataStore> {
  const result = await exportModelStep({
    modelId: 'm', dataStore: store,
    options: { schema: 'IFC4', applyMutations: true, georefMutations: useViewerStore.getState().georefMutations.get('m') },
    scheduleState: null,
  });
  return parse(typeof result.content === 'string' ? new TextEncoder().encode(result.content) : result.content);
}

it('applies a safe fix as one undo step, re-checks the edited model, and the export is clean (#10608)', async () => {
  const store = await fixture('height-in-millimetres');
  seed(store);
  const host = panel(store);
  assert.equal(await settled(host), '1 warning');
  openList(host);
  assert.ok(host.querySelector('[data-finding-code="ORTHOGONAL_HEIGHT_IMPLAUSIBLE"]'));
  const apply = button(host, 'Apply fix');
  assert.ok(apply, 'a ready fix offers Apply fix');
  click(apply);

  assert.equal(useViewerStore.getState().georefMutations.get('m')?.mapConversion?.orthogonalHeight, 540,
    'OrthogonalHeight 540000 (millimetres) is rewritten as 540 in the map unit');
  assert.equal(await settled(host), 'No problems found', 'the check follows the unsaved edit');
  const saved = await exported(store);
  assert.equal(extractGeoreferencingOnDemand(saved)?.mapConversion?.orthogonalHeight, 540, 'the exported file carries the fix');

  act(() => useViewerStore.getState().undo('m'));
  assert.equal(useViewerStore.getState().georefMutations.get('m')?.mapConversion?.orthogonalHeight, 540000,
    'one undo reverts the whole fix');
  assert.equal(await settled(host), '1 warning', 'and the check sees the authored value again');

  cleanup();
  seed(saved);
  assert.equal(await settled(panel(saved)), 'No problems found', 'the exported file checks clean on reopen');
});

it('warns when the map position lies outside the CRS area of use, with the EPSG box and a swap fix (#10608)', async () => {
  const store = await fixture('outside-area-swapped');
  seed(store);
  const host = panel(store);
  await settled(host);
  const alert = outsideAreaAlert(host);
  assert.ok(alert, 'the out-of-area warning shows without opening the list');
  const text = alert.textContent ?? '';
  assert.match(text, /Outside the area of use of EPSG:2056\./);
  assert.match(text, AREA_OF_USE_2056, text);

  const apply = button(host, 'Apply fix');
  assert.ok(apply, 'swapping Eastings and Northings is a ready fix');
  click(apply);
  const edited = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
  assert.equal(edited?.eastings, 2600000);
  assert.equal(edited?.northings, 1199650);
  await settled(host);
  assert.equal(outsideAreaAlert(host), undefined, 'the warning clears once the edit puts the model inside');

  act(() => useViewerStore.getState().undo('m'));
  const undone = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
  assert.deepEqual([undone?.eastings, undone?.northings], [1199650, 2600000], 'one undo reverts both fields');
  await settled(host);
  assert.ok(outsideAreaAlert(host), 'and the warning is back');
});

it('says a finding the panel already explains is explained there, and keeps no fix for the double position (#10608)', async () => {
  const store = await fixture('double-site-placement');
  seed(store);
  // The site placement already carries the LV95 position (in millimetres), so
  // the geometry sits at the map coordinates the MapConversion adds again.
  const at = { x: 2600005, y: 0, z: -1199654 };
  const coordinateInfo: CoordinateInfo = {
    originShift: at,
    shiftedBounds: { min: { x: -5, y: 0, z: -4 }, max: { x: 5, y: 0, z: 4 } },
    originalBounds: { min: { x: at.x - 5, y: 0, z: at.z - 4 }, max: { x: at.x + 5, y: 0, z: at.z + 4 } },
    hasLargeCoordinates: true,
  };
  const host = panel(store, { coordinateInfo });
  assert.equal(await settled(host), '1 error');
  openList(host);
  const row = host.querySelector('[data-finding-code="MAP_POSITION_APPLIED_TWICE"]');
  assert.ok(row);
  assert.match(row.textContent ?? '', /Explained in this panel's double-georeferencing note/);
  assert.equal(button(host, 'Apply fix'), undefined);
});

it('offers no fix in a read-only panel (#10608)', async () => {
  const store = await fixture('height-in-millimetres');
  seed(store);
  const host = panel(store, { editable: false });
  assert.equal(await settled(host), '1 warning');
  openList(host);
  assert.ok(host.querySelector('[data-finding-code="ORTHOGONAL_HEIGHT_IMPLAUSIBLE"]'));
  assert.equal(button(host, 'Apply fix'), undefined);
});

it('shows the EPSG area of use in a lookup result (#10608, #10398)', async () => {
  const host = render(<EpsgLookupDialog onSelect={() => {}} />);
  const trigger = host.querySelector('button');
  assert.ok(trigger, 'the lookup trigger renders');
  click(trigger);
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input');
  assert.ok(input, 'the lookup dialog opens');
  type(input, '2056');
  const row = (): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((b) => b.querySelector('code')?.textContent === '2056');
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && !AREA_OF_USE_2056.test(row()?.textContent ?? '');) await advance(25);
  assert.match(row()?.textContent ?? '', AREA_OF_USE_2056, 'the 2056 result shows its area of use');
});
