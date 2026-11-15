/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import JSZip from 'jszip';
import { inspectIfcArchiveAdmission } from './archiveServerAdmission.js';

for (const image of [null, 'textures/wall.png', 'textures/wall.JPG']) {
  it(`#10264 ZIP admission inspects metadata without inflating model or dropping ${image ?? 'a texture-free server route'}`, async () => {
    const entries: Record<string, Uint8Array> = { 'model.ifc': strToU8('ISO-10303-21;'.repeat(20000)) };
    if (image) entries[image] = new Uint8Array([1, 2, 3]);
    const file = new File([zipSync(entries, { level: 0 }) as BlobPart], 'model.ifcZIP');
    const reads: number[] = [], slice = file.slice.bind(file);
    Object.defineProperty(file, 'arrayBuffer', { value: () => { throw new Error('whole archive read'); } });
    Object.defineProperty(file, 'slice', { value: (start?: number, end?: number) => {
      const part = slice(start, end); reads.push(part.size); return part;
    } });
    assert.deepEqual(await inspectIfcArchiveAdmission(file), { modelBytes: entries['model.ifc'].byteLength, allowsServer: image === null });
    assert.equal(reads.length, 2 + 2 * Object.keys(entries).length);
    assert.ok(reads.slice(2).reduce((sum, size) => sum + size, 0) <= 1024 * 1024);
    assert.ok(reads[0] <= 65557 && reads[1] <= 1024 * 1024);
  });
}

for (const fault of ['truncated', 'oversized-directory', 'zip64', 'multipart', 'extra-model', 'unicode-path', 'zip64-extra', 'zip64-extra-only', 'zip64-compressed-size', 'zip64-local-offset'] as const) {
  it(`#10264 ZIP ${fault} cannot authorize an uninspected server upload`, async () => {
    let bytes = zipSync({ 'model.ifc': strToU8('ISO-10303-21;'), ...(fault === 'extra-model' ? { 'other.ifc': strToU8('ISO-10303-21;') } : {}) },
      fault === 'unicode-path' ? { extra: { 0x7075: new Uint8Array([1, 0, 0, 0, 0, ...strToU8('hidden.png')]) } } :
      fault.startsWith('zip64-extra') ? { extra: { 0x0001: new Uint8Array(8) } } : {});
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), end = bytes.length - 22;
    if (fault === 'truncated') bytes = bytes.slice(0, -5);
    if (fault === 'oversized-directory') view.setUint32(end + 12, 1024 * 1024 + 1, true);
    if (fault === 'zip64') view.setUint32(end + 16, 0xffffffff, true);
    if (fault === 'zip64-extra' || fault === 'zip64-compressed-size') view.setUint32(view.getUint32(end + 16, true) + 20, 0xffffffff, true);
    if (fault === 'zip64-local-offset') view.setUint32(view.getUint32(end + 16, true) + 42, 0xffffffff, true);
    if (fault === 'multipart') view.setUint16(end + 4, 1, true);
    assert.equal(await inspectIfcArchiveAdmission(new File([bytes as BlobPart], 'model.ifcZIP')), null);
  });
}

it('#10264 ZIP local-header image aliases are refused before source upload', async () => {
  const bytes = zipSync({ 'model.ifc': strToU8('ISO-10303-21;'), 'wall.txt': new Uint8Array([1, 2, 3]) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cursor = view.getUint32(bytes.length - 22 + 16, true);
  for (let i = 0; i < 2; i++) {
    const length = view.getUint16(cursor + 28, true);
    if (new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + length)) === 'wall.txt')
      bytes.set(strToU8('wall.png'), view.getUint32(cursor + 42, true) + 30);
    cursor += 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  assert.ok((await JSZip.loadAsync(bytes)).files['wall.png'], 'the real extractor sees the local PNG name');
  assert.equal(await inspectIfcArchiveAdmission(new File([bytes as BlobPart], 'model.ifcZIP')), null);
});
