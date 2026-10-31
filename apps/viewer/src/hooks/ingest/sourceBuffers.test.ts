/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The loader's single-source-buffer helpers. A STEP file streamed into a
 * SharedArrayBuffer used to be copied whole into an ArrayBuffer for the zip
 * check and format detection; the copy then lived for the session.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { unwrapIfcZipWithResources } from '@ifc-lite/parser';
import { headIsZip, sourceArrayBuffer } from './sourceBuffers.js';

const STEP = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');

describe('sourceArrayBuffer', () => {
  it('returns an ArrayBuffer source itself, without copying', () => {
    const ab = STEP.slice().buffer;
    assert.equal(sourceArrayBuffer(ab, 'test.copy'), ab);
  });

  it('copies a SharedArrayBuffer source into an equal ArrayBuffer', () => {
    const sab = new SharedArrayBuffer(STEP.byteLength);
    new Uint8Array(sab).set(STEP);
    const copy = sourceArrayBuffer(sab, 'test.copy');
    assert.ok(copy instanceof ArrayBuffer);
    assert.deepEqual(new Uint8Array(copy), STEP);
  });
});

describe('headIsZip', () => {
  it('agrees with the unwrap API on what an archive is', async () => {
    const zip = new JSZip();
    zip.file('model.ifc', STEP);
    const archive = await zip.generateAsync({ type: 'arraybuffer' });
    const head = archive.slice(0, 4096);
    assert.equal(headIsZip(head), true);
    const unwrapped = await unwrapIfcZipWithResources(archive);
    assert.deepEqual(new Uint8Array(unwrapped.model), STEP, 'precondition: the unwrap API sees an archive');

    const plain = STEP.slice().buffer;
    assert.equal(headIsZip(plain.slice(0, 4096)), false);
    assert.equal((await unwrapIfcZipWithResources(plain)).model, plain, 'precondition: the unwrap API sees no archive');
  });

  it('treats a head shorter than the signature as not an archive', () => {
    assert.equal(headIsZip(new Uint8Array([0x50, 0x4b, 0x03]).buffer), false);
    assert.equal(headIsZip(new ArrayBuffer(0)), false);
  });
});
