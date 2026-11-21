/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { inspectLocalIfcAdmission } from './localIfcAdmission.js';
import { classifyLoadError } from '@/lib/load-errors';
import { formatLoadError } from '@/lib/load-error-message';

describe('local IFC admission (#10264)', () => {
  it('warns at the browser-capped 8 GB report, refuses below it, and admits a larger known budget', () => {
    for (const size of [1.05e9, 1.26e9]) {
      assert.ok(inspectLocalIfcAdmission(size, 8), '8 may describe a workstation, so requires consent');
      assert.throws(() => inspectLocalIfcAdmission(size, 4), /memory budget.*3\.0 GiB budget/);
      assert.doesNotThrow(() => inspectLocalIfcAdmission(size, 16));
    }
  });

  it('keeps ordinary loads and the existing 256 MiB streaming path eligible', () => {
    for (const size of [0, 20e6, 256 * 1024 ** 2 + 1]) {
      assert.doesNotThrow(() => inspectLocalIfcAdmission(size, 4));
    }
  });

  it('retains the independent wasm32 source-size limit on a large-memory device', () => {
    assert.throws(() => inspectLocalIfcAdmission(2 ** 31, 128), /source must be smaller/);
    for (const size of [-1, NaN, Infinity]) {
      assert.throws(() => inspectLocalIfcAdmission(size, 8), /finite non-negative integer/);
    }
  });

  it('uses the conservative unknown-memory policy for unreadable reports', () => {
    for (const memory of [0, -1, NaN, Infinity]) {
      assert.ok(inspectLocalIfcAdmission(1.05e9, memory), 'unknown memory requires a warning rather than inventing a small device');
    }
  });
});

describe('local IFC admission without WebAssembly SIMD (#10784)', () => {
  it('refuses before anything is fetched, with the translated explanation instead of the compile error', (t) => {
    t.after(() => mock.restoreAll());
    mock.method(WebAssembly, 'validate', () => false);
    let refusal: unknown;
    assert.throws(() => inspectLocalIfcAdmission(20e6, 16), (err) => { refusal = err; return true; });
    assert.equal(classifyLoadError(refusal, 'ifc_model_load'), 'wasm_simd_unsupported');
    assert.match(formatLoadError(refusal, 'model.ifc', 'ifc_model_load'), /can't run the WebAssembly SIMD instructions/);
  });
});
