/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalIfcAdmission } from './localIfcAdmission.js';

describe('local IFC admission (#10264)', () => {
  it('refuses both reported OOM source sizes on an 8 GB device before any payload is needed', () => {
    for (const size of [1.05e9, 1.26e9]) {
      assert.throws(() => assertLocalIfcAdmission(size, 8), /memory budget.*6\.0 GiB budget/);
      assert.doesNotThrow(() => assertLocalIfcAdmission(size, 16));
    }
  });

  it('keeps ordinary loads and the existing 256 MiB streaming path eligible', () => {
    for (const size of [0, 20e6, 256 * 1024 ** 2 + 1]) {
      assert.doesNotThrow(() => assertLocalIfcAdmission(size, 4));
    }
  });

  it('retains the independent wasm32 source-size limit on a large-memory device', () => {
    assert.throws(() => assertLocalIfcAdmission(2 ** 31, 128), /source must be smaller/);
    for (const size of [-1, NaN, Infinity]) {
      assert.throws(() => assertLocalIfcAdmission(size, 8), /finite non-negative integer/);
    }
  });

  it('uses the conservative unknown-memory policy for unreadable reports', () => {
    for (const memory of [0, -1, NaN, Infinity]) {
      assert.throws(() => assertLocalIfcAdmission(1.05e9, memory), /6\.0 GiB budget/);
    }
  });
});
