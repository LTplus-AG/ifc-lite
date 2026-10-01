/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6639: the displayed convention agrees with edited and exported IFC axes. */
import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractGeoreferencingOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { cleanup, render, click, type, press } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { exportModelStep } from '@/lib/export/model-step-export';
import { GeoreferencingPanel } from './GeoreferencingPanel';

const initialState = useViewerStore.getState();
const ROTATION_LABEL = 'Model rotation in map coordinates';

afterEach(() => {
  cleanup();
  useViewerStore.setState(initialState, true);
});

// IFC4 invariant fixture: map East=(1,0), North=(0,1), local X=(a,b).
// Scale is deliberately optional so omission can survive an export/reload.
function fixture(a = 1, b = 0, scale = '$'): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Proj00000000000000001',$,'Project',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION((1.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#71=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#31);
#73=IFCMAPCONVERSION(#20,#71,2600000.,1200000.,500.,${a},${b},${scale});
ENDSEC;
END-ISO-10303-21;`;
}

async function parse(content: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}

function mount(dataStore: IfcDataStore, editable = true): HTMLElement {
  const georef = extractGeoreferencingOnDemand(dataStore);
  assert.ok(georef?.mapConversion);
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: dataStore }),
    georefMutations: new Map(),
  });
  const host = render(<GeoreferencingPanel georef={georef} schemaVersion="IFC4" modelId="m" enableEditing={editable} />);
  const operation = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('Coordinate Operation'));
  assert.ok(operation);
  click(operation);
  return host;
}

function valueButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('button')].find(button => button.getAttribute('aria-label')?.startsWith(`${label}:`));
  assert.ok(button, `editable value for ${label} must be reachable`);
  return button;
}

function openEditor(host: HTMLElement, label: string): HTMLInputElement {
  click(valueButton(host, label));
  const input = [...host.querySelectorAll('input')].find(input => input.getAttribute('aria-label') === label);
  assert.ok(input, `inline editor for ${label} must render`);
  return input;
}

async function exportedGeoref(dataStore: IfcDataStore) {
  const result = await exportModelStep({
    modelId: 'm', dataStore,
    options: { schema: 'IFC4', applyMutations: true, georefMutations: useViewerStore.getState().georefMutations.get('m') },
    scheduleState: null,
  });
  const georef = extractGeoreferencingOnDemand(await parse(result.content));
  assert.ok(georef?.mapConversion, 'exported STEP must retain its map conversion');
  return georef.mapConversion;
}

for (const degrees of [30, -30]) {
  it(`exports ${degrees}° as the counterclockwise model-X direction in map coordinates (#6639)`, async () => {
    const dataStore = await parse(fixture());
    const host = mount(dataStore);
    assert.match(host.textContent ?? '', /Counterclockwise/);
    const input = openEditor(host, ROTATION_LABEL);
    type(input, String(degrees));
    press(input, 'Enter');
    assert.match(valueButton(host, ROTATION_LABEL).getAttribute('aria-label') ?? '', new RegExp(`: ${degrees}°$`));
    const conversion = await exportedGeoref(dataStore);
    const radians = degrees * Math.PI / 180;
    assert.ok(Math.abs((conversion.xAxisAbscissa ?? NaN) - Math.cos(radians)) < 1e-9);
    assert.ok(Math.abs((conversion.xAxisOrdinate ?? NaN) - Math.sin(radians)) < 1e-9);
    assert.equal(conversion.eastings, 2600000, 'editing rotation preserves translation');
    assert.equal(conversion.northings, 1200000);
    assert.equal(conversion.scale, undefined, 'editing rotation preserves the omitted scale');
  });
}

it('displays the same 45° direction for a non-unit vector and preserves its authored components (#6639)', async () => {
  const dataStore = await parse(fixture(2, 2));
  const host = mount(dataStore);
  assert.equal(valueButton(host, ROTATION_LABEL).getAttribute('aria-label'), `${ROTATION_LABEL}: 45°`);
  assert.equal(valueButton(host, 'XAxisAbscissa').getAttribute('aria-label'), 'XAxisAbscissa: 2');
  assert.equal(valueButton(host, 'XAxisOrdinate').getAttribute('aria-label'), 'XAxisOrdinate: 2');
  const input = openEditor(host, ROTATION_LABEL);
  press(input, 'Enter');
  assert.equal(useViewerStore.getState().georefMutations.has('m'), false,
    'accepting the displayed angle preserves the original non-unit vector');
  const conversion = await exportedGeoref(dataStore);
  assert.equal(conversion.xAxisAbscissa, 2);
  assert.equal(conversion.xAxisOrdinate, 2);
});

it('shows omitted Scale as Default: 1 and leaves a no-op edit omitted on export (#6639)', async () => {
  const dataStore = await parse(fixture());
  const host = mount(dataStore);
  assert.equal(valueButton(host, 'Scale').getAttribute('aria-label'), 'Scale: Default: 1');
  const input = openEditor(host, 'Scale');
  assert.equal(input.value, '1', 'the editor seeds the effective IFC default');
  type(input, '1');
  press(input, 'Enter');
  assert.equal(useViewerStore.getState().georefMutations.has('m'), false, 'accepting the effective default does not author a value');
  assert.equal((await exportedGeoref(dataStore)).scale, undefined);
});

it('preserves a non-unit vector when accepting its rounded angle display (#6639)', async () => {
  const dataStore = await parse(fixture(2, 3));
  const host = mount(dataStore);
  const input = openEditor(host, ROTATION_LABEL);
  assert.equal(input.value, '56.309932', 'the angle editor seeds the six-digit display');
  assert.notEqual(Number(input.value), Math.atan2(3, 2) * 180 / Math.PI,
    'the displayed seed has less precision than the authored direction');
  press(input, 'Enter');
  assert.equal(useViewerStore.getState().georefMutations.has('m'), false,
    'accepting the rounded seed does not rewrite its higher-precision direction');
  const conversion = await exportedGeoref(dataStore);
  assert.equal(conversion.xAxisAbscissa, 2);
  assert.equal(conversion.xAxisOrdinate, 3);
});

it('authors a changed Scale from its omitted default and preserves it on export (#6639)', async () => {
  const dataStore = await parse(fixture());
  const host = mount(dataStore);
  const input = openEditor(host, 'Scale');
  assert.equal(input.value, '1');
  type(input, '0.001');
  press(input, 'Enter');
  assert.equal(valueButton(host, 'Scale').getAttribute('aria-label'), 'Scale: 0.001',
    'the edited authored value replaces the default annotation');
  const conversion = await exportedGeoref(dataStore);
  assert.equal(conversion.scale, 0.001);
  assert.equal(conversion.xAxisAbscissa, 1, 'changing scale preserves the direction');
  assert.equal(conversion.xAxisOrdinate, 0);
});

it('distinguishes authored Scale 1 from the omitted default (#6639)', async () => {
  const dataStore = await parse(fixture(1, 0, '1.'));
  const host = mount(dataStore);
  assert.equal(valueButton(host, 'Scale').getAttribute('aria-label'), 'Scale: 1');
  assert.equal((await exportedGeoref(dataStore)).scale, 1);
});

it('explains the rotation convention and omitted scale when editing is disabled (#6639)', async () => {
  const host = mount(await parse(fixture()), false);
  assert.match(host.textContent ?? '', /Model rotation in map coordinates/);
  assert.match(host.textContent ?? '', /Counterclockwise/);
  assert.match(host.textContent ?? '', /Default: 1/);
  assert.equal(host.querySelector('input'), null);
});
