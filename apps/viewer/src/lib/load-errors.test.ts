/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadError, formatLoadError } from './load-errors.js';

describe('classifyLoadError', () => {
  it('classifies the wasm-bindgen non-OK HTTP status as wasm_engine_load', () => {
    // The exact message captured in PostHog issue 019ed949 (Edge/Windows).
    const err = new TypeError(
      "Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok",
    );
    assert.equal(classifyLoadError(err), 'wasm_engine_load');
  });

  it('classifies streaming-compile/instantiate WebAssembly failures', () => {
    for (const verb of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
      const err = new TypeError(`Failed to execute '${verb}' on 'WebAssembly': bad`);
      assert.equal(classifyLoadError(err), 'wasm_engine_load', verb);
    }
  });

  it('classifies a blocked/failed engine-binary fetch', () => {
    assert.equal(classifyLoadError(new Error('Failed to fetch ifc-lite_bg.wasm')), 'wasm_engine_load');
    assert.equal(classifyLoadError(new Error('NetworkError when attempting to fetch wasm')), 'wasm_engine_load');
  });

  it('classifies out-of-memory failures', () => {
    assert.equal(classifyLoadError(new Error('memory access out of bounds')), 'out_of_memory');
    assert.equal(classifyLoadError(new Error('Cannot enlarge memory arrays')), 'out_of_memory');
  });

  it('classifies cancellation', () => {
    assert.equal(classifyLoadError(new Error('The operation was aborted')), 'cancelled');
    assert.equal(classifyLoadError('cancelled'), 'cancelled');
  });

  it('falls back to unknown for unrelated errors', () => {
    assert.equal(classifyLoadError(new Error('Unexpected token in IFC header')), 'unknown');
  });

  it('handles non-Error inputs', () => {
    assert.equal(classifyLoadError(undefined), 'unknown');
    assert.equal(classifyLoadError({ nope: true }), 'unknown');
  });
});

describe('formatLoadError', () => {
  it('gives actionable reload guidance for engine-load failures', () => {
    const msg = formatLoadError(
      new TypeError("Failed to execute 'compile' on 'WebAssembly': HTTP status code is not ok"),
      'tower.ifc',
    );
    assert.match(msg, /geometry engine/i);
    assert.match(msg, /reload/i);
    // The cryptic raw message must NOT leak to the user for known failures.
    assert.doesNotMatch(msg, /HTTP status code is not ok/);
  });

  it('preserves the raw message for unknown failures', () => {
    const msg = formatLoadError(new Error('Unexpected token in IFC header'), 'tower.ifc');
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /Unexpected token in IFC header/);
  });

  it('works without a file name', () => {
    const msg = formatLoadError(new Error('boom'));
    assert.match(msg, /the model/);
  });
});
