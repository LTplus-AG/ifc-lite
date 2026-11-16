/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { zipSync, strToU8 } from 'fflate';
import { unwrapIfcZipWithResources } from '@ifc-lite/parser';
import { createLocalIfcLoadAdmission } from './confirmLocalIfcAdmission.js';

const step = 'ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'IFC4\'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;';
const image = new Uint8Array([1, 2, 3]);
async function archive(layout: 'unicode' | 'zip64'): Promise<Uint8Array<ArrayBuffer>> {
  if (layout === 'unicode') {
    const zip = new JSZip();
    zip.file('Gebäude.ifc', step); zip.file('wall.png', image);
    return new Uint8Array(await zip.generateAsync({ type: 'uint8array' })); // real UTF-8 + Unicode Path fields, including their CRC
  }
  const size = strToU8(step).length, extra = new Uint8Array(16), sizes = new DataView(extra.buffer);
  sizes.setUint32(0, size, true); sizes.setUint32(8, size, true);
  const bytes = new Uint8Array(zipSync({ 'model.ifc': strToU8(step), 'wall.png': image }, { level: 0, extra: { 0x0001: extra } }));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), directory = view.getUint32(bytes.length - 22 + 16, true);
  // Model sizes use the actual ZIP64 extra; EOCD remains within ordinary small-file limits.
  for (const offset of [18, 22, directory + 20, directory + 24]) view.setUint32(offset, 0xffffffff, true);
  return bytes;
}

for (const layout of ['unicode', 'zip64'] as const) it(`#10264 small ${layout} ZIP remains readable with bounded local extraction and sibling images`, async () => {
  const bytes = await archive(layout), file = new File([bytes], 'small.ifcZIP'), failures: unknown[] = [];
  const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => true, signal: new AbortController().signal,
    onCancel: () => assert.fail('ordinary small ZIP needs no consent'), onFailure: error => failures.push(error), finish: () => {} });
  assert.notEqual(await admission.preflight(), null, 'small compatible ZIP must pass preflight');
  assert.deepEqual(failures, []);
  assert.equal(admission.allowsServer(), false, 'unknown names/layout must never certify an image-free upload');
  assert.equal(admission.archiveModelLimit(), 64 * 1024 * 1024, 'unknown model size has a fixed bound, not an unlimited expansion');
  const extracted = await unwrapIfcZipWithResources(bytes.buffer, admission.archiveModelLimit());
  assert.equal(new TextDecoder().decode(extracted.model), step, 'the real extractor recovers the complete IFC bytes');
  assert.deepEqual(extracted.originalResources.get('wall.png'), image);
  // A malicious large declaration is still refused before allocating its payload.
  const view = new DataView(bytes.buffer), directory = view.getUint32(bytes.length - 22 + 16, true);
  if (layout === 'unicode') {
    view.setUint32(directory + 24, 64 * 1024 * 1024 + 1, true);
    await assert.rejects(unwrapIfcZipWithResources(bytes.buffer, admission.archiveModelLimit()), /over the .* limit/);
  }
});

it('#10264 an uninspectable ZIP above the small-input bound is refused without whole-source acquisition', async () => {
  const bytes = await archive('unicode'), file = new File([bytes], 'large.ifcZIP'), failures: unknown[] = [];
  Object.defineProperty(file, 'size', { value: 1024 * 1024 + 1 });
  Object.defineProperty(file, 'arrayBuffer', { value: () => { assert.fail('whole archive acquisition before refusal'); } });
  const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => true, signal: new AbortController().signal,
    onCancel: () => assert.fail('uninspectable large ZIP requires extraction'), onFailure: error => failures.push(error), finish: () => {} });
  assert.equal(await admission.preflight(), null);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /Cannot safely inspect.*Extract the IFC/);
});

it('#10264 the bounded small-ZIP compatibility allowance still obeys device memory refusal', async () => {
  const memory = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 0.5 });
  try {
    const file = new File([await archive('unicode')], 'low-memory.ifcZIP'), failures: unknown[] = [];
    const admission = createLocalIfcLoadAdmission(file, { isCurrent: () => true, signal: new AbortController().signal,
      onCancel: () => assert.fail('low-memory refusal is not consent'), onFailure: error => failures.push(error), finish: () => {} });
    assert.equal(await admission.preflight(), null);
    assert.equal(failures.length, 1);
    assert.match(String(failures[0]), /local processing memory budget/);
  } finally {
    if (memory) Object.defineProperty(navigator, 'deviceMemory', memory); else Reflect.deleteProperty(navigator, 'deviceMemory');
  }
});
