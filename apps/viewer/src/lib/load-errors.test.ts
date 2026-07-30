/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadError, errorCaptureProps, formatLoadError } from './load-errors.js';

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

  it('classifies the wrong-MIME engine binary as wasm_engine_load (issue #1363)', () => {
    // A deploy rotated the hashed wasm under an open tab, so the 404 page
    // (served as text/plain) stands in for it and the streaming loader rejects.
    // Firefox phrasing (the exact message captured in PostHog):
    assert.equal(
      classifyLoadError(
        new TypeError(
          "WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'",
        ),
      ),
      'wasm_engine_load',
    );
    // Chromium phrasing:
    assert.equal(
      classifyLoadError(
        new TypeError("Incorrect response MIME type. Expected 'application/wasm'."),
      ),
      'wasm_engine_load',
    );
    // Wrapped by the geometry worker pool, it must still classify the same.
    assert.equal(
      classifyLoadError(
        new Error(
          "Geometry worker error: WebAssembly: Response has unsupported MIME type 'text/plain; charset=utf-8' expected 'application/wasm'",
        ),
      ),
      'wasm_engine_load',
    );
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

  it('classifies a WebGPU buffer-allocation failure as out_of_memory', () => {
    // Chromium's wording is misleading — 193 KB is not "too large" for any
    // device; what failed is mapping host memory. Same user guidance as OOM.
    assert.equal(
      classifyLoadError(new RangeError(
        "Failed to execute 'createBuffer' on 'GPUDevice': createBuffer failed, size (193836) is too large for the implementation when mappedAtCreation == true",
      )),
      'out_of_memory',
    );
  });

  it('classifies an unreadable picked file, not as a memory or model failure', () => {
    assert.equal(
      classifyLoadError(new Error(
        'NotReadableError: The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired.',
      )),
      'file_unreadable',
    );
    // A DOMException stringifies name-first; also match engines that only
    // phrase it in prose.
    assert.equal(
      classifyLoadError(new Error('The requested file could not be read due to permission problems')),
      'file_unreadable',
    );
  });

  it('classifies a DOMException by its stable .name, whatever the message says', () => {
    // `.message` is engine-specific prose that need not repeat the name — only
    // `.name` is stable, and `messageOf` alone would never see it.
    const domException = Object.assign(new Error('The operation failed'), {
      name: 'NotReadableError',
    });
    assert.equal(classifyLoadError(domException), 'file_unreadable');
  });

  it('does not mistake unrelated read failures for an unreadable file', () => {
    assert.equal(classifyLoadError(new Error('could not be read')), 'unknown');
    assert.equal(
      classifyLoadError(new Error('Geometry worker error: Array buffer allocation failed')),
      'out_of_memory',
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

  // Issue #1903: a fetch that fails at the transport layer rejects with the
  // browser's bare house phrasing and an EMPTY stack, so `unknown` was the one
  // bucket it could never leave — no fingerprint, no severity, no triage.
  it('classifies a bare transport failure as network_unavailable', () => {
    assert.equal(classifyLoadError(new TypeError('Load failed')), 'network_unavailable'); // WebKit
    assert.equal(classifyLoadError(new TypeError('Failed to fetch')), 'network_unavailable'); // Chromium
    assert.equal(
      classifyLoadError(new TypeError('NetworkError when attempting to fetch resource.')),
      'network_unavailable',
    ); // Gecko
    assert.equal(
      classifyLoadError(new Error('The network connection was lost.')),
      'network_unavailable',
    );
    assert.equal(
      classifyLoadError(new Error('The Internet connection appears to be offline.')),
      'network_unavailable',
    );
  });

  // A failure that named itself must keep its own, more actionable kind — the
  // network bucket is checked last precisely so it cannot swallow them.
  it('does not let network_unavailable outrank a self-identifying failure', () => {
    assert.equal(
      classifyLoadError(
        new Error('Failed to load the WASM engine binary (ifc-lite_bg.wasm) in ifc-lite-bridge: Load failed'),
      ),
      'wasm_engine_load',
    );
    // The worker pool's wrapper is itself an attribution, so it wins too — and
    // once the worker's own init attributes the binary (#1903), the wrapped
    // form carries the more specific engine-load kind.
    assert.equal(
      classifyLoadError(new Error('Geometry worker error: Failed to fetch')),
      'geometry_worker_crash',
    );
    assert.equal(
      classifyLoadError(
        new Error(
          'Geometry worker error: Failed to load the WASM engine binary (ifc-lite_bg.wasm) in geometry.worker: Failed to fetch',
        ),
      ),
      'wasm_engine_load',
    );
  });

  // Only `.name` is stable on an aborted fetch: WebKit words the message
  // "Fetch is aborted", Chromium "The user aborted a request." — neither of
  // which the message matcher can be keyed on.
  it('classifies an AbortError by its stable name as cancelled', () => {
    assert.equal(
      classifyLoadError(new DOMException('Fetch is aborted', 'AbortError')),
      'cancelled',
    );
  });
});

describe('errorCaptureProps', () => {
  // The properties that make a STACKLESS exception triageable. Flat by
  // contract: posthog-js takes them as the event's own properties.
  it('reports the throwable identity even when the message says nothing', () => {
    const props = errorCaptureProps(new TypeError('Load failed'));
    assert.equal(props.error_kind, 'network_unavailable');
    assert.equal(props.error_type, 'TypeError');
  });

  it('prefers a DOMException\'s stable name over its constructor', () => {
    const props = errorCaptureProps(new DOMException('Fetch is aborted', 'AbortError'));
    assert.equal(props.error_type, 'AbortError');
    assert.equal(props.error_kind, 'cancelled');
  });

  it('survives a thrown non-Error', () => {
    const props = errorCaptureProps('something went sideways');
    assert.equal(props.error_kind, 'unknown');
    assert.equal(props.error_type, 'String');
  });

  // Key naming is load-bearing — `scrubProperties` deletes any key with a
  // `_`-delimited `name` / `url` / `path` word, so it must never be
  // `error_name`, and no URL may be attached. See analytics-scrub.ts.
  it('emits no key the privacy scrub would delete', () => {
    const props = errorCaptureProps(new TypeError('Load failed'));
    for (const key of Object.keys(props)) {
      assert.doesNotMatch(
        key,
        /(?:^|_)(?:name|filename|model|title|label|path|url|uri|href|message)(?:$|_)/i,
        `errorCaptureProps key "${key}" would be deleted by the analytics privacy scrub`,
      );
    }
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

  it('tells the user to re-pick an unreadable file instead of blaming the model', () => {
    const msg = formatLoadError(
      new Error('NotReadableError: The requested file could not be read'),
      'tower.ifc',
    );
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /select the file again/i);
    // Must NOT tell them to close tabs / shrink the model — nothing is too big.
    assert.doesNotMatch(msg, /memory|too large|smaller/i);
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

  // #1903: the user saw `Failed to load "x.ifc": Load failed`, which explains
  // nothing and suggests nothing.
  it('gives connection guidance for a bare transport failure instead of dumping it', () => {
    const msg = formatLoadError(new TypeError('Load failed'), 'tower.ifc');
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /connection/i);
    assert.doesNotMatch(msg, /Load failed/);
  });

  it('routes the attributed engine-binary failure to the reload guidance', () => {
    const msg = formatLoadError(
      new Error('Failed to load the WASM engine binary (ifc-lite_bg.wasm) in ifc-lite-bridge: Load failed'),
      'tower.ifc',
    );
    assert.match(msg, /geometry engine/i);
    assert.match(msg, /reload/i);
  });
});

// ── #1898: wasm runtime traps must be a bucket of their own ────────────────
//
// The reported occurrence was recorded as `error_kind: unknown` with an
// internal sentence ("…recreate the worker process before calling init()
// again") shown to the user, because a bare wasm trap matched none of the
// buckets above.
describe('wasm runtime traps (#1898)', () => {
  it('classifies a bare WebAssembly trap as wasm_runtime_crashed', () => {
    assert.equal(
      classifyLoadError(new WebAssembly.RuntimeError('unreachable')),
      'wasm_runtime_crashed',
    );
  });

  it('classifies a cross-realm trap by its stable .name', () => {
    // Re-raised out of a worker: `instanceof` fails, `.name` survives.
    const crossRealm = new Error('unreachable');
    crossRealm.name = 'RuntimeError';
    assert.equal(classifyLoadError(crossRealm), 'wasm_runtime_crashed');
  });

  it('keeps a stringified trap unknown, so #1196 stays settled', () => {
    // The analytics path only ever sees text. Matching trap phrasing there
    // would sweep other viewer wasm (space-plate, parquet) into this family's
    // single issue fingerprint — the exact mis-bucketing #1196 forbids.
    assert.equal(classifyLoadError('RuntimeError: unreachable executed'), 'unknown');
    assert.equal(classifyLoadError(new Error('unreachable')), 'unknown');
  });

  it('classifies the engine unrecoverable marker', () => {
    assert.equal(
      classifyLoadError(
        new Error('WASM_RUNTIME_UNRECOVERABLE: … (underlying wasm trap: unreachable)'),
      ),
      'wasm_runtime_crashed',
    );
  });

  it('does not steal a worker-attributed trap from the worker bucket', () => {
    assert.equal(
      classifyLoadError(new Error('Geometry worker error: unreachable')),
      'geometry_worker_crash',
    );
  });

  it('does not steal an explicit OOM from the memory bucket', () => {
    assert.equal(
      classifyLoadError(new WebAssembly.RuntimeError('memory access out of bounds')),
      'out_of_memory',
    );
  });

  it('offers a reload for an unrecoverable engine crash, without the internal text', () => {
    const msg = formatLoadError(
      new Error(
        'WASM_RUNTIME_UNRECOVERABLE: the IFC-Lite WebAssembly geometry engine trapped during ' +
          'init, so this document has no working engine instance. Reload the page to get a ' +
          'fresh one. (underlying wasm trap: unreachable)',
      ),
      'tower.ifc',
    );
    assert.match(msg, /reload the page/i);
    // The user must never see the engine's internal prose — no diagnostic code,
    // no raw trap text, no "call init() again"/"recreate the worker process".
    assert.doesNotMatch(msg, /WASM_RUNTIME_UNRECOVERABLE|underlying wasm trap|unreachable/i);
    assert.doesNotMatch(msg, /wasm-bindgen|init\(\)|worker process/i);
  });

  it('explains a recoverable operation trap without demanding a reload first', () => {
    const msg = formatLoadError(new WebAssembly.RuntimeError('unreachable'), 'tower.ifc');
    assert.match(msg, /"tower\.ifc"/);
    assert.match(msg, /geometry engine crashed/i);
    assert.match(msg, /memory/i);
    assert.doesNotMatch(msg, /unreachable/);
  });
});
