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

  it('classifies the main-thread RangeError OOM (issue #1215)', () => {
    // The exact message captured in PostHog issue 019edcc2 (Chrome/Windows).
    assert.equal(classifyLoadError(new RangeError('Array buffer allocation failed')), 'out_of_memory');
  });

  it('classifies a hard geometry-worker crash (issue #1203)', () => {
    // worker.onerror with an empty ErrorEvent used to read "undefined"; it now
    // synthesises a message, and either form must bucket as a worker crash.
    assert.equal(classifyLoadError(new Error('Geometry worker failed: undefined')), 'geometry_worker_crash');
    assert.equal(
      classifyLoadError(new Error('Geometry worker failed: worker terminated unexpectedly')),
      'geometry_worker_crash',
    );
  });

  it('classifies a wasm trap only when the worker marker is present (issue #1196)', () => {
    // The worker pool wraps its failures, so a real geometry trap arrives with
    // the "Geometry worker error:" prefix and is attributable.
    assert.equal(classifyLoadError(new Error('Geometry worker error: unreachable')), 'geometry_worker_crash');
    // A BARE wasm trap is NOT attributed to geometry — other viewer wasm
    // (space-plate, parquet) can trap too, so it stays unknown and surfaces on
    // its own instead of being mis-bucketed/suppressed as the geometry family.
    assert.equal(classifyLoadError(new Error('unreachable')), 'unknown');
    assert.equal(classifyLoadError(new Error('RuntimeError: unreachable executed')), 'unknown');
  });

  it('prefers out_of_memory over worker_crash when the worker died with a clear OOM', () => {
    assert.equal(
      classifyLoadError(new Error('Geometry worker error: Cannot enlarge memory arrays')),
      'out_of_memory',
    );
  });

  it('classifies the geometry stream watchdog timeout (issues #1194/#1204)', () => {
    assert.equal(
      classifyLoadError(new Error('Geometry stream stalled after 40000ms. Last rendered meshes: 0.')),
      'geometry_stream_stalled',
    );
  });

  it('does not depend on a file name in the stall message (privacy)', () => {
    // The watchdog Error must never carry the model name; classification keys
    // only on the stable prefix.
    assert.equal(
      classifyLoadError(new Error('Geometry stream stalled after 90000ms. Last rendered meshes: 3473.')),
      'geometry_stream_stalled',
    );
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

  it('gives actionable memory guidance for a worker crash without leaking the raw message', () => {
    const msg = formatLoadError(new Error('Geometry worker failed: undefined'), 'tower.ifc');
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /memory/i);
    assert.doesNotMatch(msg, /undefined/);
  });

  it('gives actionable guidance for a stream stall and re-attaches the file name for the user', () => {
    const msg = formatLoadError(
      new Error('Geometry stream stalled after 40000ms. Last rendered meshes: 0.'),
      'tower.ifc',
    );
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /stalled/i);
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
