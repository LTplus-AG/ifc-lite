/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat } from './index.js';

it('detects shared source prefixes without a whole-file copy (#6537)', () => {
  for (const [text, expected] of [['ISO-10303-21;', 'ifc'], ['{ "header": {} }', 'ifcx'], ['glTF', 'glb'], ['not a model', 'unknown']] as const) {
    const source = new SharedArrayBuffer(4096);
    new Uint8Array(source).set(new TextEncoder().encode(text));
    const slices: number[] = [];
    const original = Uint8Array.prototype.slice;
    Uint8Array.prototype.slice = function(start?: number, end?: number) {
      if (this.buffer === source) slices.push(this.byteLength);
      return original.call(this, start, end);
    };
    try {
      assert.equal(detectFormat(source), expected);
      assert.ok(slices.every(size => size <= 100), 'SAB-safe UTF-8 decoding may copy only the bounded prefix');
    } finally {
      Uint8Array.prototype.slice = original;
    }
  }
});
