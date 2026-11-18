/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { IfcParser } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { render, cleanup, click, waitFor, advance } from '@/test/render';
import { downloadedNames, clearDownloads } from '@/test/download-capture';
import { toast } from '@/components/ui/toast';
import { CityJsonExportDialog, cityJsonEngine } from './CityJsonExportDialog';

const wasm = new URL('../../../../../packages/wasm/pkg-rhino/ifc-lite-rhino_bg.wasm', import.meta.url);
const skip = existsSync(wasm) ? false : 'Export WASM absent; run pnpm build:wasm';
afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); useViewerStore.setState({ georefMutations: new Map() }); });
function button(label: string) {
  const node = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(node, `button ${label}`);
  return node;
}
async function open(sample: string, removeBuilding = false) {
  // happy-dom supplies window, so initialize with bytes rather than fetching a file URL.
  const engine = await import('@ifc-lite/wasm/rhino');
  await engine.default({ module_or_path: readFileSync(wasm) });
  let text = readFileSync(new URL(`../../../public/samples/${sample}`, import.meta.url), 'utf8');
  if (removeBuilding) text = text.replace(/IFCBUILDING\(/g, 'IFCBUILDINGELEMENTPROXY(');
  const bytes = new TextEncoder().encode(text);
  const ifcDataStore = await new IfcParser().parseColumnar(bytes.buffer);
  const model = { ...fixtureModel('m'), name: sample, sourceFile: new File([text], sample), ifcDataStore };
  useViewerStore.setState({ ...fixtureModels(model), ifcDataStore });
  const blobs: Blob[] = [];
  mock.method(URL, 'createObjectURL', (blob: Blob) => { blobs.push(blob); return 'blob:cityjson-test'; });
  render(<CityJsonExportDialog surface="ribbon" />);
  click(button('Export CityJSON'));
  await advance(1);
  return blobs;
}

for (const sequence of [false, true]) it(`real buildingSMART fixture exports ${sequence ? 'CityJSONSeq' : 'CityJSON'} (#10607)`, { skip }, async () => {
  const blobs = await open('building-architecture.ifc');
  if (sequence) {
    click(document.querySelector('#cityjson-format')!);
    await advance(1);
    const option = [...document.querySelectorAll('[role="option"]')].find((n) => n.textContent?.includes('CityJSONSeq'));
    assert.ok(option); click(option); await advance(1);
  }
  click(button('Export'));
  await waitFor(() => blobs.length === 1, 'CityJSON download');
  const text = await blobs[0].text();
  const docs = sequence ? text.trim().split('\n').map((line) => JSON.parse(line)) : [JSON.parse(text)];
  assert.equal(docs[0].type, 'CityJSON');
  assert.equal(docs[0].version, '2.0');
  assert.ok(docs[0].metadata.referenceSystem.includes('32760'));
  assert.ok(Object.keys(docs[sequence ? 1 : 0].CityObjects).length >= 1);
  if (sequence) assert.equal(docs[1].type, 'CityJSONFeature');
  assert.ok(downloadedNames()[0].endsWith(sequence ? '.city.jsonl' : '.city.json'));
});

it('local fixture shows notice before export and surfaces producer warnings (#10607)', { skip }, async () => {
  const info: string[] = [];
  mock.method(toast, 'info', (message: string) => { info.push(message); return ''; });
  const blobs = await open('hello-wall.ifc');
  assert.ok(document.body.textContent?.includes('local coordinates, not map coordinates'));
  click(button('Export'));
  await waitFor(() => blobs.length === 1 && info.length === 1, 'local export warnings');
  assert.equal(JSON.parse(await blobs[0].text()).metadata.referenceSystem, undefined);
  assert.match(info[0], /not georeferenced/i);
});

it('session georeferencing edits are written: edited CRS, offsets and extent (#10602)', { skip }, async () => {
  const blobs = await open('hello-wall.ifc');
  const store = useViewerStore.getState();
  store.setGeorefFields('m', 'projectedCRS', [{ field: 'name', value: 'EPSG:2056' }, { field: 'mapUnit', value: 'METRE' }]);
  store.setGeorefFields('m', 'mapConversion', [{ field: 'eastings', value: 2_600_000 }, { field: 'northings', value: 1_200_000 }, { field: 'orthogonalHeight', value: 400 }]);
  await advance(1);
  const text = document.body.textContent ?? '';
  assert.ok(!text.includes('local coordinates, not map coordinates'), 'no local notice once the session georeferences the model');
  assert.ok(text.includes('Writes coordinates in EPSG:2056'), 'names the CRS that will be written');
  click(button('Export'));
  await waitFor(() => blobs.length === 1, 'CityJSON download');
  const doc = JSON.parse(await blobs[0].text());
  assert.equal(doc.metadata.referenceSystem, 'https://www.opengis.net/def/crs/EPSG/0/2056');
  const [tx, ty, tz] = doc.transform.translate;
  const [minX, minY, minZ, maxX, maxY, maxZ] = doc.metadata.geographicalExtent;
  // hello-wall's wall sits within metres of the IFC origin, so map coordinates are the edited offsets plus that.
  for (const [v, base] of [[tx, 2_600_000], [ty, 1_200_000], [tz, 400], [minX, 2_600_000], [minY, 1_200_000], [minZ, 400], [maxX, 2_600_000], [maxY, 1_200_000], [maxZ, 400]] as const) {
    assert.ok(Math.abs(v - base) < 50, `${v} near ${base}`);
  }
  assert.ok(minX <= maxX && minY <= maxY && minZ <= maxZ);
  assert.ok(tx <= minX + 1e-6 && ty <= minY + 1e-6 && tz <= minZ + 1e-6, 'translate is consistent with the extent');
});

it('without session edits the output is the file\'s own export, byte for byte (#10602)', { skip }, async () => {
  const blobs = await open('building-architecture.ifc');
  click(button('Export'));
  await waitFor(() => blobs.length === 1, 'CityJSON download');
  const { exportCityJson } = await import('@ifc-lite/geometry');
  const raw = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url));
  assert.equal(await blobs[0].text(), (await exportCityJson(new Uint8Array(raw), {})).text);
  assert.ok(!(document.body.textContent ?? '').includes('Writes coordinates in'), 'no CRS line without session edits');
});

it('a failed geometry chunk load fails the export inline instead of escaping (#10607 review)', async () => {
  // The subject is the catch path: the shell would rethrow an escaped rejection and render no inline result.
  mock.method(cityJsonEngine, 'load', () => Promise.reject(new Error('Failed to fetch dynamically imported module')));
  mock.method(console, 'error', () => {});
  const model = { ...fixtureModel('m'), name: 'a.ifc', sourceFile: new File(['ISO-10303-21;'], 'a.ifc'), ifcDataStore: null };
  useViewerStore.setState({ ...fixtureModels(model) });
  render(<CityJsonExportDialog surface="ribbon" />);
  click(button('Export CityJSON'));
  await advance(1);
  click(button('Export'));
  await waitFor(() => document.body.textContent?.includes('CityJSON export failed: Failed to fetch dynamically imported module') === true, 'inline load failure');
  assert.equal(downloadedNames().length, 0);
});

it('model without IfcBuilding shows the real refusal inline and never downloads (#10607)', { skip }, async () => {
  const blobs = await open('hello-wall.ifc', true);
  click(button('Export'));
  await waitFor(() => document.body.textContent?.includes('CityJSON export failed:') === true, 'inline refusal');
  assert.match(document.body.textContent ?? '', /IfcBuilding/i);
  assert.equal(blobs.length, 0);
  assert.equal(downloadedNames().length, 0);
});
