/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10608: the Georeference panel's georef-check diagnosis, through the real
 * parser, the SDK doctor (offline CRS engine, bundled EPSG catalogue) and the
 * viewer store, over `@ifc-lite/georef-check`'s committed fixtures.
 */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser, extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { cleanup, click, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { exportModelStep } from '@/lib/export/model-step-export';
import { diagnoseModelGeoreference } from '@/lib/geo/georef-diagnosis';
import GeorefDiagnosisSection from './georef-diagnosis-section';
import { EpsgAreaOfUseLine } from './epsg-area-of-use';
import { GeoreferencingPanel } from './GeoreferencingPanel';

const FIXTURES = new URL('../../../../../../packages/georef-check/fixtures/', import.meta.url);
const initialState = useViewerStore.getState();

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

async function parse(bytes: Uint8Array): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

async function fixture(name: string): Promise<IfcDataStore> {
  return parse(new Uint8Array(readFileSync(new URL(`${name}.ifc`, FIXTURES))));
}

function seed(store: IfcDataStore): void {
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }),
    editEnabled: true,
    georefMutations: new Map(),
  });
}

/** Let the lazy diagnosis settle: poll until the summary is no longer "Checking…". */
async function settled(host: HTMLElement): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const summary = host.querySelector('[data-testid="georef-check-summary"]')?.textContent ?? '';
    if (summary && summary !== 'Checking…') return summary;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  assert.fail('the georeferencing check did not finish');
}

function button(host: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
}

function openList(host: HTMLElement): void {
  const toggle = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Georeferencing check'));
  assert.ok(toggle, 'the check header renders');
  click(toggle);
}

async function exportedCodes(store: IfcDataStore): Promise<string[]> {
  const result = await exportModelStep({
    modelId: 'm', dataStore: store,
    options: { schema: 'IFC4', applyMutations: true, georefMutations: useViewerStore.getState().georefMutations.get('m') },
    scheduleState: null,
  });
  const diagnosis = await diagnoseModelGeoreference(await parse(typeof result.content === 'string' ? new TextEncoder().encode(result.content) : result.content), undefined);
  assert.ok(diagnosis);
  return diagnosis.items.map((item) => item.finding.code);
}

it('applies a safe fix as one undo step, re-checks the edited model, and the export is clean (#10608)', async () => {
  const store = await fixture('height-in-millimetres');
  seed(store);
  const host = render(<GeorefDiagnosisSection modelId="m" editable shownInPanel={{ doubleGeoref: false, scaleMismatch: false }} />);
  assert.equal(await settled(host), '1 warning');
  openList(host);
  assert.ok(host.querySelector('[data-finding-code="ORTHOGONAL_HEIGHT_IMPLAUSIBLE"]'));
  const apply = button(host, 'Apply fix');
  assert.ok(apply, 'a ready fix offers Apply fix');
  click(apply);

  assert.equal(useViewerStore.getState().georefMutations.get('m')?.mapConversion?.orthogonalHeight, 540,
    'OrthogonalHeight 540000 (millimetres) is rewritten as 540 in the map unit');
  assert.equal(await settled(host), 'No problems found', 'the check follows the unsaved edit');
  assert.deepEqual(await exportedCodes(store), [], 'the exported file carries the fix');

  act(() => useViewerStore.getState().undo('m'));
  assert.equal(useViewerStore.getState().georefMutations.get('m')?.mapConversion?.orthogonalHeight ?? 540000, 540000,
    'one undo reverts the whole fix');
  assert.equal(await settled(host), '1 warning', 'and the check sees the authored value again');
});

it('warns when the map position lies outside the CRS area of use, with the EPSG box and a swap fix (#10608)', async () => {
  const store = await fixture('outside-area-swapped');
  seed(store);
  const host = render(<GeorefDiagnosisSection modelId="m" editable shownInPanel={{ doubleGeoref: false, scaleMismatch: false }} />);
  await settled(host);
  const alert = host.querySelector('[role="alert"]');
  assert.ok(alert, 'the out-of-area warning shows without opening the list');
  const text = alert.textContent ?? '';
  assert.match(text, /Outside the area of use of EPSG:2056\./);
  assert.match(text, /Area of use: longitude 5\.\d+° to 10\.\d+°, latitude 45\.\d+° to 47\.\d+°\./, text);

  const apply = button(host, 'Apply fix');
  assert.ok(apply, 'swapping Eastings and Northings is a ready fix');
  click(apply);
  const edited = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
  assert.equal(edited?.eastings, 2600000);
  assert.equal(edited?.northings, 1199650);
  await settled(host);
  assert.equal(host.querySelector('[role="alert"]'), null, 'the warning clears once the edit puts the model inside');

  act(() => useViewerStore.getState().undo('m'));
  const undone = useViewerStore.getState().georefMutations.get('m')?.mapConversion;
  assert.deepEqual([undone?.eastings ?? 1199650, undone?.northings ?? 2600000], [1199650, 2600000], 'one undo reverts both fields');
  await settled(host);
  assert.ok(host.querySelector('[role="alert"]'), 'and the warning is back');
});

it('says a finding the panel already explains is explained there, and keeps no fix for the double position (#10608)', async () => {
  const store = await fixture('double-site-placement');
  seed(store);
  const host = render(<GeorefDiagnosisSection modelId="m" editable shownInPanel={{ doubleGeoref: true, scaleMismatch: false }} />);
  assert.equal(await settled(host), '1 error');
  openList(host);
  const row = host.querySelector('[data-finding-code="MAP_POSITION_APPLIED_TWICE"]');
  assert.ok(row);
  assert.match(row.textContent ?? '', /Explained in this panel's double-georeferencing note/);
  assert.equal(button(host, 'Apply fix'), undefined);
});

it('offers no fix in a read-only panel (#10608)', async () => {
  seed(await fixture('height-in-millimetres'));
  const host = render(<GeorefDiagnosisSection modelId="m" shownInPanel={{ doubleGeoref: false, scaleMismatch: false }} />);
  await settled(host);
  openList(host);
  assert.ok(host.querySelector('[data-finding-code="ORTHOGONAL_HEIGHT_IMPLAUSIBLE"]'));
  assert.equal(button(host, 'Apply fix'), undefined);
});

it('mounts in the Georeference panel through its lazy gate (#10608)', async () => {
  const store = await fixture('height-in-millimetres');
  seed(store);
  const georef = extractGeoreferencingOnDemand(store);
  const host = render(<GeoreferencingPanel georef={georef} schemaVersion="IFC4" modelId="m" enableEditing lengthUnitScale={0.001} />);
  assert.equal(await settled(host), '1 warning');
});

it('shows the EPSG area of use in a lookup result, and nothing for a code without one (#10608, #10398)', async () => {
  const host = render(<><div data-code="2056"><EpsgAreaOfUseLine code="2056" /></div><div data-code="0"><EpsgAreaOfUseLine code="0" /></div></>);
  for (let i = 0; i < 200 && !host.querySelector('[data-code="2056"]')?.textContent; i++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  }
  assert.match(host.querySelector('[data-code="2056"]')?.textContent ?? '', /^Area of use: longitude 5\.\d+° to 10\.\d+°, latitude 45\.\d+° to 47\.\d+°\.$/);
  assert.equal(host.querySelector('[data-code="0"]')?.textContent, '');
});
