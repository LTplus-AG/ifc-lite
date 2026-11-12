/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The content sniffer that routes a dropped file. A Rhino `.3dm` used to fall
 * through to `unknown` and on into the IFC wasm path
 * (docs/architecture/rhino-3dm-import.md, "Format detection and entry").
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from './detect-format.js';

const bufferOf = (text: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

/** The 32-byte header Rhino writes: the magic, then right-aligned version digits. */
const rhinoHeader = (version: number): ArrayBuffer =>
  bufferOf(`3D Geometry File Format ${String(version).padStart(8, ' ')}`.slice(0, 32) + '\u0000\u0000\u0000\u0000');

describe('detectFormat', () => {
  it('reads a Rhino archive header as 3dm', () => {
    assert.equal(detectFormat(rhinoHeader(70)), '3dm');
    assert.equal(detectFormat(rhinoHeader(80)), '3dm');
  });

  it('keeps the other formats on their own branches', () => {
    assert.equal(detectFormat(bufferOf('ISO-10303-21;\nHEADER;')), 'ifc');
    assert.equal(detectFormat(bufferOf('{"header":{}}')), 'ifcx');
    assert.equal(detectFormat(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]).buffer), 'glb');
    assert.equal(detectFormat(bufferOf('nothing in particular')), 'unknown');
  });

  it('does not take a truncated or near-miss magic for a .3dm', () => {
    assert.equal(detectFormat(bufferOf('3D Geometry File')), 'unknown');
    assert.equal(detectFormat(bufferOf('3D geometry file format 70')), 'unknown');
    assert.equal(detectFormat(new ArrayBuffer(0)), 'unknown');
  });
});
