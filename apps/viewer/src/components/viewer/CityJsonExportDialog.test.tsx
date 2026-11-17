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
import { CityJsonExportDialog } from './CityJsonExportDialog';

const wasm = new URL('../../../../../packages/wasm/pkg-rhino/ifc-lite-rhino_bg.wasm', import.meta.url);
const skip = existsSync(wasm) ? false : 'Export WASM absent; run pnpm build:wasm';
afterEach(() => { cleanup(); clearDownloads(); mock.restoreAll(); });
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

it('model without IfcBuilding shows the real refusal inline and never downloads (#10607)', { skip }, async () => {
  const blobs = await open('hello-wall.ifc', true);
  click(button('Export'));
  await waitFor(() => document.body.textContent?.includes('CityJSON export failed:') === true, 'inline refusal');
  assert.match(document.body.textContent ?? '', /IfcBuilding/i);
  assert.equal(blobs.length, 0);
  assert.equal(downloadedNames().length, 0);
});
