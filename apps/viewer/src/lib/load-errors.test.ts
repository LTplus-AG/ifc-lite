/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoadError, errorCaptureProps } from './load-errors.js';
import { formatLoadError } from './load-error-message.js';

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

  // #2410. `cancelled` is in `BENIGN_ERROR_KINDS`, so matching it downgrades the
  // event to `warning` and fingerprints it into the cancellation issue — an
  // actionable failure taken off the error-level list. The old
  // `/\bcancel(?:led|ed)?\b/` fired on the word anywhere in the message (and,
  // with both suffixes optional, on a bare "cancel"), so any failure that
  // merely mentioned one was relabelled benign.
  it('never buckets a failure that merely MENTIONS a cancellation as cancelled', () => {
    for (const message of [
      'Upload failed: driver shim logged cancelled while retrying',
      // Bare "cancel" is not a cancellation: the old matcher's `(?:led|ed)?`
      // made both suffixes optional, so the verb alone was enough.
      'Cannot cancel: the export already finished writing 0 bytes',
      'Failed to save: the server said the subscription was cancelled',
      // The subject must be the message's OWN opening words, not something
      // reached across a `:`. Widening the leading-word class to allow the
      // colon through is invisible to every carrier above — they all put more
      // than two words in front of the token — and this is what kills it.
      'Retry failed: cancelled requests must not be replayed',
      // The bare token has no subject to name, so it gets no trailing latitude:
      // a sentence bolted onto it is not a cancellation report.
      'cancelled and our upload pipeline then wrote 0 bytes',
      'The operation was aborted and our upload pipeline then wrote 0 bytes',
      // `AbortError` is matched as the STRINGIFIED NAME, which only means
      // anything at the start of the value. Mentioned mid-sentence it is prose
      // about an abort, not an abort.
      'Upload failed: the shim swallowed an AbortError and wrote 0 bytes',
    ]) {
      assert.equal(classifyLoadError(new Error(message)), 'unknown', message);
    }
  });

  // …while the forms our own code actually throws keep their kind. These are
  // verbatim from `syncSourceModel.ts` and `packages/mcp/src/tools/clash.ts`,
  // which is what stops the anchor being tightened into matching nothing real.
  it('still classifies the cancellation wordings we author', () => {
    for (const message of [
      'Sync cancelled: tower.ifc was removed while its update was downloading.',
      'Sync cancelled: tower.ifc was removed while its update was loading.',
      'Clash run cancelled before meshing.',
      // A cross-realm throwable reaches the analytics path as `String(err)`.
      'AbortError: The user aborted a request.',
    ]) {
      assert.equal(classifyLoadError(message), 'cancelled', message);
    }
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

  // #2410: the transport wordings come FROM `fetch()`, so they ARE the whole
  // message. Anything that wraps one is by construction ours. This matters more
  // than for the other kinds because `network_unavailable` is the most dangerous
  // label in the file — analytics-scrub.ts downgrades it to `warning` AND
  // deletes the event outright when the browser also reported the user offline.
  it('never buckets a WRAPPED transport phrase as network_unavailable', () => {
    for (const message of [
      'Upload failed: driver shim logged Failed to fetch while retrying',
      'Import aborted: the worker reported Load failed for chunk 3 of 9',
      'Retry loop saw NetworkError when attempting to fetch resource and gave up',
      'Sync stopped: the mirror said The network connection was lost midway',
      'Failed to fetch and our upload pipeline then wrote 0 bytes',
      'Load failed, and our upload pipeline then wrote 0 bytes',
      // The stringified-name prefix is BOUNDED for a reason: unbound, it is an
      // arbitrary leading sentence that happens to end in "…Error:", and every
      // carrier above still passes while this walks through.
      'Upload failed: the driver shim threw a TransportError: Load failed',
    ]) {
      assert.equal(classifyLoadError(new Error(message)), 'unknown', message);
    }
  });

  // A cross-realm throwable reaches the analytics path as `String(err)`, so the
  // stringified-name prefix is structural and must not cost the classification.
  it('classifies a stringified transport failure with its error-name prefix', () => {
    assert.equal(classifyLoadError('TypeError: Load failed'), 'network_unavailable');
    assert.equal(classifyLoadError('TypeError: Failed to fetch'), 'network_unavailable');
    // The BARE `Error:` form, which is the commonest of all and which a
    // `{1,32}` bound silently excluded (Codex review on #2431). Built through
    // `String(new Error(...))` rather than written out, so the test cannot
    // drift from what the runtime actually produces.
    assert.equal(classifyLoadError(String(new Error('Load failed'))), 'network_unavailable');
    assert.equal(classifyLoadError(String(new Error('cancelled'))), 'cancelled');
    assert.equal(
      classifyLoadError(String(new Error('Sync cancelled: tower.ifc was removed.'))),
      'cancelled',
    );
    assert.equal(classifyLoadError(String(new Error('The operation was aborted'))), 'cancelled');
  });

  // A failure that named itself must keep its own, more actionable kind — the
  // network bucket is checked last precisely so it cannot swallow them.
  // A rotated JS chunk after a redeploy is OUR breakage, not the user's
  // connection. Its Chromium wording contains "Failed to fetch", so an
  // unanchored `network_unavailable` claims it — which both fingerprints it
  // together with genuine offline blips AND hands it to the benign-severity
  // downgrade in analytics-scrub.ts, silencing a real deploy failure that
  // survived main.tsx's one-shot chunk-reload budget. #2410 removed the explicit
  // exclusion that used to say so, because the whole-message anchor subsumes it
  // (the message names the module, so it is not the whole wording) — leaving
  // this test as the live gate on that anchor rather than an unreachable branch.
  it('never buckets a failed module import as network_unavailable', () => {
    for (const message of [
      'Failed to fetch dynamically imported module: https://example.test/assets/Viewport-Bq3x.js',
      'error loading dynamically imported module: https://example.test/assets/Viewport-Bq3x.js',
      'Importing a module script failed.', // WebKit
    ]) {
      assert.notEqual(classifyLoadError(new TypeError(message)), 'network_unavailable');
      assert.notEqual(classifyLoadError(new TypeError(message)), 'cancelled');
    }
    // …but the ENGINE BINARY's own dynamic-import failure still self-identifies,
    // because isWasmEngineLoadError claims `.wasm` messages before this bucket.
    assert.equal(
      classifyLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://example.test/assets/ifc-lite_bg-Bq3x.wasm',
        ),
      ),
      'wasm_engine_load',
    );
  });

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

  // #1903: only `.name` is stable on an aborted fetch: WebKit words the message
  // "Fetch is aborted", Chromium "The user aborted a request." — neither of
  // which the message matcher can be keyed on.
  it('classifies an AbortError by its stable name as cancelled', () => {
    assert.equal(
      classifyLoadError(new DOMException('Fetch is aborted', 'AbortError')),
      'cancelled',
    );
  });

  // ── webgl_unavailable (#2354) ─────────────────────────────────────────────
  // The minimap's WebGL reports arrived as four separate PostHog issues (and
  // GitHub issues) for one benign, handled condition, because the default
  // grouping hashes the stack and the stack names the hashed bundle — so each
  // deploy split the same message again. Classifying the family is what gives
  // `analytics-scrub.ts` a stable fingerprint and the right severity.
  it('classifies every shape of the minimap WebGL failure as webgl_unavailable', () => {
    // The two messages LocationMap synthesizes; both are verbatim from the
    // PostHog issues 019fdc16 / 019fc748 (probe) and 019fccaa / 019fc35e
    // (context lost) — two issues each, for one string each.
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL (pre-flight probe)')),
      'webgl_unavailable',
    );
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL (context lost)')),
      'webgl_unavailable',
    );
    // MapLibre v6's own wording, carried by the error LocationMap reconstructs
    // when the constructor returns without a painter.
    const v6 = new Error('WebGL2 is required to display this map. The map could not start: MapLibre built no painter.');
    v6.name = 'GPUInitializationError';
    assert.equal(classifyLoadError(v6), 'webgl_unavailable');
    // v5's JSON blob, the shape PostHog issue 019fae1d recorded uncaught.
    assert.equal(
      classifyLoadError(new Error(JSON.stringify({
        requestedAttributes: { depth: true, stencil: true },
        statusMessage: 'OES_packed_depth_stencil support is required.',
        type: 'webglcontextcreationerror',
        message: 'Failed to initialize WebGL',
      }))),
      'webgl_unavailable',
    );
  });

  it('classifies three.js\'s WebGL refusal into the same family (#2458)', () => {
    // The reversal of the #2354 decision, and it turns on a fact that changed
    // rather than a change of mind. Then: PostHog issue 019fc458 was
    // `THREE.WebGLRenderer: Error creating WebGL context.` escaping the MCP
    // hero's mount effect and taking the /mcp route down through
    // ChunkErrorBoundary (recorded under `lazy_subtree_boundary`), and folding a
    // page-killing crash into the benign minimap family would have hidden it.
    // Now: #2401 put both /mcp scenes behind `useThreeScene`, and they are the
    // only WebGLRenderer construction sites in this app, so these strings can
    // only arrive as a handled degradation of one panel — the same device
    // condition the minimap reports, and it belongs in the same bucket instead
    // of minting one issue per wording.
    assert.equal(
      classifyLoadError(new Error('THREE.WebGLRenderer: Error creating WebGL context.')),
      'webgl_unavailable',
    );
    assert.equal(
      classifyLoadError(new Error('THREE.WebGLRenderer: Error creating WebGL context with your selected attributes.')),
      'webgl_unavailable',
    );
    // The synthesised pre-flight message — the arm that fires first, and
    // therefore the one most sessions actually report.
    assert.equal(
      classifyLoadError(new Error('THREE.WebGLRenderer: Error creating WebGL context. (pre-flight probe)')),
      'webgl_unavailable',
    );
  });

  it('does NOT claim a message that merely QUOTES three\'s wording (#2458)', () => {
    // Same anchoring discipline as the MapLibre arms below: one of our own
    // failures that wraps three's message for context is a bug of ours, and
    // must keep its own identity rather than inherit a device-capability
    // fingerprint nobody triages. Both ends, because anchoring one fixes one.
    assert.equal(
      classifyLoadError(new Error('THREE.WebGLRenderer: Error creating WebGL context. while building the hero')),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error('HeroScene failed: THREE.WebGLRenderer: Error creating WebGL context.')),
      'unknown',
    );
    // Not three's failure at all: a lost context is a different condition with
    // a different remedy, and three words it differently on purpose.
    assert.equal(
      classifyLoadError(new Error('THREE.WebGLRenderer: Context Lost.')),
      'unknown',
    );
  });

  it('does NOT claim an error that merely MENTIONS the phrase (#1914/#2354)', () => {
    // The hazard the drop matcher in analytics-scrub.ts anchors against, now
    // that the same predicate also assigns `error_kind`. A substring test here
    // would hand an unrelated bug of ours the minimap's fingerprint AND its
    // benign severity — filed into an issue nobody triages. Both the trailing
    // and the leading form, because anchoring only one end fixes only one.
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL renderer for the section overlay')),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error('SectionOverlay: Failed to initialize WebGL')),
      'unknown',
    );
  });

  it('does NOT claim text that merely EMBEDS the v5 token or the v6 wording (#2354)', () => {
    // Second round of the same defect: anchoring one arm of the OR left the
    // other two as bare `includes`. A `"type":"webglcontextcreationerror"`
    // token can appear inside a wrapped driver string, a serialized log line or
    // a nested payload, and MapLibre's v6 sentence can be quoted mid-message.
    // Membership must require the token to BE the payload's `type` field, and
    // the v6 wording to START the message.
    assert.equal(
      classifyLoadError(new Error(
        'Upload failed: driver shim logged {"type":"webglcontextcreationerror"} while retrying',
      )),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error(JSON.stringify({
        error: 'render target lost',
        context: '{"type":"webglcontextcreationerror"}',
      }))),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error(
        'TileCache: WebGL2 is required to display this map, so the raster fallback was used',
      )),
      'unknown',
    );
  });

  it('accepts only the exact spacing LocationMap emits (#2354)', () => {
    // The suffix is joined by ONE literal space at the call site, so the
    // matcher takes one literal space. `\s*` there would have admitted spacing
    // no code produces, which is latitude the matcher has no reason to grant.
    // This test also documents the coupling: change the string LocationMap
    // builds and this fails rather than silently falling back to per-deploy
    // issue churn.
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL  (context lost)')),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL(context lost)')),
      'unknown',
    );
    assert.equal(
      classifyLoadError(new Error('Failed to initialize WebGL (context lost)')),
      'webgl_unavailable',
    );
  });

  it('still requires a COMPLETE v5 payload, not just the type field (#2354)', () => {
    // The `type` field alone is not the failure: v5 always paired it with the
    // bare message. A payload carrying the token but a different message is
    // some other event of MapLibre's, not the context-creation throw.
    assert.equal(
      classifyLoadError(new Error(JSON.stringify({
        type: 'webglcontextcreationerror',
        message: 'Tile source could not be added',
      }))),
      'unknown',
    );
    // …and the genuine pairing still classifies.
    assert.equal(
      classifyLoadError(new Error(JSON.stringify({
        statusMessage: 'OES_packed_depth_stencil support is required.',
        type: 'webglcontextcreationerror',
        message: 'Failed to initialize WebGL',
      }))),
      'webgl_unavailable',
    );
  });

  it('leaves an unrelated GPU failure out of the webgl_unavailable bucket', () => {
    // Narrowness guard: the viewport renderer is WebGPU, and its failures are
    // not a minimap capability gap.
    assert.equal(classifyLoadError(new Error('Failed to initialize WebGPU adapter')), 'unknown');
    assert.equal(
      classifyLoadError(new Error('WebGL warning: drawArrays: no program bound')),
      'unknown',
    );
  });

  it('keeps the driver\'s own prose from being mis-bucketed (#2354)', () => {
    // The driver's `statusMessage` is vendor text we do not control, and it is
    // free to contain the words the memory/network matchers key on. The WebGL
    // check runs first precisely so this lands in its own family instead of
    // out_of_memory.
    assert.equal(
      classifyLoadError(new Error(JSON.stringify({
        statusMessage: 'Could not create a WebGL context, allocation failed: .',
        type: 'webglcontextcreationerror',
        message: 'Failed to initialize WebGL',
      }))),
      'webgl_unavailable',
    );
  });
});

describe('errorCaptureProps', () => {
  // #1903: the properties that make a STACKLESS exception triageable — the
  // reported event had no `stacktrace` key at all. Flat by contract:
  // posthog-js takes them as the event's own properties.
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
