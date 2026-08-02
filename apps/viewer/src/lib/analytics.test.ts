/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scrubEvent } from './analytics-scrub.js';
import { beforeSend } from './analytics.js';
import { __setChunkReloadPendingForTests } from './chunk-version-skew.js';

// `scrubEvent` is the single `before_send` gate every captured event passes
// through: it drops unactionable third-party noise, tags the geometry
// error family with a stable `error_kind`, and scrubs PII / confidential
// model identifiers. These tests pin that contract.

type CaptureEvent = { event?: string; properties?: Record<string, unknown> };

const exceptionEvent = (value: string, extraProps: Record<string, unknown> = {}): CaptureEvent => ({
  event: '$exception',
  properties: {
    $exception_list: [{ type: 'Error', value }],
    ...extraProps,
  },
});

describe('scrubEvent — error_kind tagging', () => {
  it('tags a wrapped worker trap but NOT a bare one (issue #1196)', () => {
    // The worker pool wraps failures, so the attributable form is tagged…
    const wrapped = scrubEvent(exceptionEvent('Geometry worker error: unreachable'));
    assert.equal(wrapped?.properties?.error_kind, 'geometry_worker_crash');
    // …but a bare wasm trap stays untagged (could be any viewer wasm, not just
    // geometry), so it is neither mislabelled nor suppressed as the family.
    const bare = scrubEvent(exceptionEvent('unreachable'));
    assert.equal(bare?.properties?.error_kind, undefined);
  });

  it('tags the main-thread RangeError OOM (issue #1215)', () => {
    const out = scrubEvent(exceptionEvent('Array buffer allocation failed'));
    assert.equal(out?.properties?.error_kind, 'out_of_memory');
  });

  it('tags the geometry stream watchdog timeout (issues #1194/#1204)', () => {
    const out = scrubEvent(exceptionEvent('Geometry stream stalled after 40000ms. Last rendered meshes: 0.'));
    assert.equal(out?.properties?.error_kind, 'geometry_stream_stalled');
  });

  it('reads the message from $exception_values when no $exception_list is present', () => {
    const out = scrubEvent({
      event: '$exception',
      properties: { $exception_values: ['Geometry worker failed: undefined'] },
    } as CaptureEvent);
    assert.equal(out?.properties?.error_kind, 'geometry_worker_crash');
  });

  it('does not clobber an error_kind set explicitly at the capture site', () => {
    const out = scrubEvent(exceptionEvent('unreachable', { error_kind: 'out_of_memory' }));
    assert.equal(out?.properties?.error_kind, 'out_of_memory');
  });

  it('leaves non-exception events untagged', () => {
    const out = scrubEvent({ event: 'ifc_model_loaded', properties: { file_size_mb: 12 } } as CaptureEvent);
    assert.equal(out?.properties?.error_kind, undefined);
  });
});

describe('scrubEvent — noise filter + PII guard (regression)', () => {
  it('drops the Cesium RequestErrorEvent noise (issue #1175)', () => {
    const out = scrubEvent({
      event: '$exception',
      properties: {
        $exception_list: [
          { type: 'Error', value: "'D_' captured as exception with keys: response, responseHeaders, statusCode" },
        ],
      },
    });
    assert.equal(out, null);
  });

  it('strips a confidential file name and path from event properties', () => {
    const out = scrubEvent({
      event: 'custom',
      // `file_name` is a sensitive key → deleted; `detail` is not sensitive but
      // its value is path-ish → redacted; `count` is plain → untouched.
      properties: { file_name: 'Confidential-Tower.ifc', detail: '/Users/me/Confidential-Tower.ifc', count: 3 },
    });
    assert.equal(out?.properties?.file_name, undefined);
    assert.equal(out?.properties?.detail, '[redacted]');
    assert.equal(out?.properties?.count, 3);
  });

  it('strips query + hash from URL auto-properties instead of deleting them', () => {
    // Regression: `$current_url` matches SENSITIVE_KEY's `url` word, so without
    // URL_KEYS being checked first it would be deleted outright, losing the
    // route. We keep the route, drop the query/hash (which can encode a model
    // id or token).
    const out = scrubEvent({
      event: '$pageview',
      properties: {
        $current_url: 'https://app.example.com/viewer?model=secret#section',
        $referrer: 'https://other.com/page?utm_source=x',
      },
    } as CaptureEvent);
    assert.equal(out?.properties?.$current_url, 'https://app.example.com/viewer');
    assert.equal(out?.properties?.$referrer, 'https://other.com/page');
  });

  it('passes a null event through untouched', () => {
    assert.equal(scrubEvent(null), null);
  });

  it("drops Outlook SafeLinks' injected-crawler rejection", () => {
    const out = scrubEvent(exceptionEvent(
      'Non-Error promise rejection captured with value: Object Not Found Matching Id:2, MethodName:update, ParamCount:4',
    ));
    assert.equal(out, null);
  });

  it('drops the opaque cross-origin "Script error." only when it has no frames', () => {
    // Information-free by construction: no file, no line, no stack.
    assert.equal(scrubEvent(exceptionEvent('Script error.')), null);
    assert.equal(scrubEvent(exceptionEvent('Script error')), null);
    // …but if one ever arrives WITH a stack, it is ours and must survive.
    const withStack: CaptureEvent = {
      event: '$exception',
      properties: {
        $exception_list: [
          { type: 'Error', value: 'Script error.', stacktrace: { frames: [{ source: '/assets/index.js' }] } },
        ],
      },
    };
    assert.notEqual(scrubEvent(withStack), null);
  });

  it('keeps exceptions that merely mention a dropped pattern in passing', () => {
    // Guard against the noise regexes being too greedy.
    assert.notEqual(scrubEvent(exceptionEvent('Failed to load Script error handler module')), null);
    assert.notEqual(scrubEvent(exceptionEvent('Object Not Found in scene graph')), null);
  });

  // ── MapLibre "no WebGL context" (issue #1914) ─────────────────────────────
  // Both strings are verbatim from error tracking: one user, one session, two
  // DIFFERENT driver messages, both recorded as UNCAUGHT. The LocationMap now
  // catches these at the source; this is the net under the one path that can
  // still escape — MapLibre re-running `_setupPainter()` from a DOM listener
  // while restoring a lost context.
  const WEBGL_MISSING_EXTENSION = JSON.stringify({
    requestedAttributes: {
      antialias: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
      desynchronized: false, alpha: true, depth: true, stencil: true,
      premultipliedAlpha: true,
    },
    statusMessage: 'OES_packed_depth_stencil support is required.',
    type: 'webglcontextcreationerror',
    message: 'Failed to initialize WebGL',
  });

  const WEBGL_GPU_CONTENTION = JSON.stringify({
    requestedAttributes: {
      antialias: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
      desynchronized: false, alpha: true, depth: true, stencil: true,
      premultipliedAlpha: true,
    },
    statusMessage:
      'Could not create a WebGL context, VENDOR = 0x1002, DEVICE = 0x1638, '
      + 'GL_VENDOR = Google Inc. (AMD), GL_RENDERER = ANGLE (AMD, AMD Radeon(TM) '
      + 'Graphics, D3D11), Sandboxed = yes, ErrorMessage = BindToCurrentSequence failed: .',
    type: 'webglcontextcreationerror',
    message: 'Failed to initialize WebGL',
  });

  /** As posthog-js records an autocaptured (uncaught) exception. */
  const uncaught = (value: string): CaptureEvent => ({
    event: '$exception',
    properties: {
      $exception_list: [{
        type: 'Error',
        value,
        mechanism: { handled: false, synthetic: false, type: 'generic' },
      }],
    },
  });

  it('drops the UNCAUGHT MapLibre WebGL-unavailable exception (both driver messages)', () => {
    assert.equal(scrubEvent(uncaught(WEBGL_MISSING_EXTENSION)), null);
    assert.equal(scrubEvent(uncaught(WEBGL_GPU_CONTENTION)), null);
    // MapLibre's other shape: no detail object, so it throws the bare message.
    assert.equal(scrubEvent(uncaught('Failed to initialize WebGL')), null);
  });

  it('KEEPS an unrelated error that merely MENTIONS the WebGL phrase', () => {
    // #1914: the bare-message arm is anchored, not a substring test. Dropping
    // is irreversible, so a matcher loose enough to eat someone else's WebGL
    // failure would blind us exactly where it matters. Neither of these is
    // MapLibre's refusal and both must survive.
    assert.notEqual(
      scrubEvent(uncaught('Failed to initialize WebGL renderer for the section overlay')),
      null,
    );
    assert.notEqual(
      scrubEvent(uncaught('SectionOverlay: Failed to initialize WebGL')),
      null,
    );
  });

  it('KEEPS the LocationMap\'s own handled report of the same condition', () => {
    // The whole point of the fix is to convert this failure from an uncaught
    // error into a deliberate, once-per-session handled report. If the drop
    // rule above also swallowed that, we would be blind to the condition.
    const handled: CaptureEvent = {
      event: '$exception',
      properties: {
        $exception_list: [{
          type: 'Error',
          value: WEBGL_MISSING_EXTENSION,
          mechanism: { handled: true, type: 'generic' },
        }],
        context: 'location_map_webgl',
        map_unavailable_reason: 'map_construction_failed',
      },
    };
    const out = scrubEvent(handled);
    assert.notEqual(out, null);
    assert.equal(out?.properties?.context, 'location_map_webgl');
    assert.equal(out?.properties?.map_unavailable_reason, 'map_construction_failed');
  });

  it('keeps an unrelated WebGL failure that merely mentions the words', () => {
    // Narrowness guard: an actionable WebGL bug of ours must not be dropped.
    assert.notEqual(scrubEvent(uncaught('Failed to initialize WebGPU adapter')), null);
    assert.notEqual(scrubEvent(uncaught('WebGL warning: drawArrays: no program bound')), null);
  });
});

describe('scrubEvent — issue grouping', () => {
  it('collapses every stream-watchdog variant onto one fingerprint', () => {
    // The volatile mesh count used to mint a separate PostHog issue (and a
    // separate GitHub issue) per value — eleven issues for one bug.
    const a = scrubEvent(exceptionEvent('Geometry stream stalled after 40000ms. Last rendered meshes: 120070.'));
    const b = scrubEvent(exceptionEvent('Geometry stream stalled after 38374ms. Last rendered meshes: 0.'));
    assert.equal(a?.properties?.$exception_fingerprint, 'ifc-lite:geometry_stream_stalled');
    assert.equal(
      a?.properties?.$exception_fingerprint,
      b?.properties?.$exception_fingerprint,
    );
  });

  it('gives each recognised family its OWN fingerprint (no over-grouping)', () => {
    const stalled = scrubEvent(exceptionEvent('Geometry stream stalled after 40000ms. Last rendered meshes: 5.'));
    const worker = scrubEvent(exceptionEvent('Geometry worker failed: worker terminated unexpectedly'));
    const oom = scrubEvent(exceptionEvent('Array buffer allocation failed'));
    assert.equal(stalled?.properties?.$exception_fingerprint, 'ifc-lite:geometry_stream_stalled');
    assert.equal(worker?.properties?.$exception_fingerprint, 'ifc-lite:geometry_worker_crash');
    assert.equal(oom?.properties?.$exception_fingerprint, 'ifc-lite:out_of_memory');
  });

  it('leaves unrecognised exceptions on PostHog default grouping', () => {
    const out = scrubEvent(exceptionEvent("Cannot read properties of undefined (reading 'toLowerCase')"));
    assert.equal(out?.properties?.$exception_fingerprint, undefined);
  });

  it('never overrides a fingerprint chosen at the capture site', () => {
    const out = scrubEvent(exceptionEvent('Array buffer allocation failed', {
      $exception_fingerprint: 'deliberate-group',
    }));
    assert.equal(out?.properties?.$exception_fingerprint, 'deliberate-group');
  });

  it('does not fingerprint non-exception events', () => {
    const out = scrubEvent({ event: 'ifc_model_loaded', properties: {} } as CaptureEvent);
    assert.equal(out?.properties?.$exception_fingerprint, undefined);
  });
});

describe('scrubEvent — nested + message redaction', () => {
  it('redacts a confidential model name nested inside an object', () => {
    // Regression: scrubProperties only walked top-level keys, so anything one
    // level down sailed straight through the privacy guard.
    const out = scrubEvent({
      event: 'custom',
      properties: { meta: { file_name: 'Confidential-Tower.ifc', detail: '/Users/me/Tower.ifc', count: 2 } },
    } as CaptureEvent);
    const meta = out?.properties?.meta as Record<string, unknown>;
    assert.equal(meta.file_name, undefined);
    assert.equal(meta.detail, '[redacted]');
    assert.equal(meta.count, 2);
  });

  it('redacts inside arrays of objects', () => {
    const out = scrubEvent({
      event: 'custom',
      properties: { models: [{ title: 'Client HQ' }, { detail: 'C:\\jobs\\HQ.ifc' }] },
    } as CaptureEvent);
    const models = out?.properties?.models as Record<string, unknown>[];
    assert.equal(models[0].title, undefined);
    assert.equal(models[1].detail, '[redacted]');
  });

  it('cuts a file name out of an exception message but keeps the message', () => {
    // The stream watchdog used to embed `file.name`; fixed at the source, but
    // the net has to cover it — three such names reached error tracking.
    const out = scrubEvent(exceptionEvent(
      'Geometry stream stalled after 40580ms while loading SV3822-UIH-CN-001-M3D-EST-003-PA.ifc. Last rendered meshes: 0.',
    ));
    const value = (out?.properties?.$exception_list as { value: string }[])[0].value;
    assert.ok(!value.includes('SV3822'), `file name survived: ${value}`);
    assert.ok(value.includes('[file]'));
    assert.ok(value.includes('Geometry stream stalled after 40580ms'));
    // Classification still works — it matches the stable prefix.
    assert.equal(out?.properties?.error_kind, 'geometry_stream_stalled');
  });

  it('redacts non-ASCII model names in $exception_values too', () => {
    const out = scrubEvent({
      event: '$exception',
      properties: {
        $exception_values: ['Geometry stream stalled while loading 16201598 Østraadt Havn - Fabian 2.ifc.'],
      },
    } as CaptureEvent);
    const values = out?.properties?.$exception_values as string[];
    assert.ok(!values[0].includes('Østraadt'), `file name survived: ${values[0]}`);
    assert.ok(values[0].includes('[file]'));
  });

  it('redacts every model name that actually reached error tracking', () => {
    // The four real leaked names, verbatim from the PostHog corpus. Spaces,
    // non-ASCII, underscores and embedded dots all have to survive redaction.
    const leaked: [string, string][] = [
      ['SV3822-UIH-CN-001-M3D-EST-003-PA.ifc', 'SV3822'],
      ['16201598 Østraadt Havn - Hovedfil BT1 Fabian 2.ifc', 'Østraadt'],
      ['bwk_rv bn15.ifc', 'bwk_rv'],
      ['Luxembourg_EMEA RTC_SST_EXE_4000.1_TOUS_Maquette HYD.ifc', 'Luxembourg'],
    ];
    for (const [name, secret] of leaked) {
      const out = scrubEvent(exceptionEvent(
        `Geometry stream stalled after 40000ms while loading ${name}. Last rendered meshes: 7.`,
      ));
      const value = (out?.properties?.$exception_list as { value: string }[])[0].value;
      assert.ok(!value.includes(secret), `leaked "${secret}" in: ${value}`);
      assert.equal(
        value,
        'Geometry stream stalled after 40000ms while loading [file]. Last rendered meshes: 7.',
      );
    }
  });

  it('redacts an ALL-LOWER-CASE model name, prefix and all', () => {
    // A "looks name-ish" heuristic left the client prefix behind here —
    // `while loading acme tower.ifc` scrubbed to `while loading acme [file]`,
    // still shipping the client name. The stop-word rule takes the whole name.
    for (const [message, secret] of [
      ['Geometry stream stalled after 40000ms while loading confidential tower.ifc.', 'confidential'],
      ['Failed to load acme corporate headquarters phase two.ifc', 'acme'],
    ] as [string, string][]) {
      const out = scrubEvent(exceptionEvent(message));
      const value = (out?.properties?.$exception_list as { value: string }[])[0].value;
      assert.ok(!value.includes(secret), `leaked "${secret}" in: ${value}`);
    }
  });

  it('does not start the run inside a stop-word', () => {
    // Without a leading \b the run could begin mid-word ("loading" -> "oading"),
    // sailing past the stop-list and leaking the prefix anyway.
    const out = scrubEvent(exceptionEvent('x while loading confidential tower.ifc.'));
    const value = (out?.properties?.$exception_list as { value: string }[])[0].value;
    assert.equal(value, 'x while loading [file].');
  });

  it('redacts a JSON model name too (IFC5/ifcx models are JSON)', () => {
    const out = scrubEvent(exceptionEvent('Failed to parse Client-Tower-A.json'));
    const value = (out?.properties?.$exception_list as { value: string }[])[0].value;
    assert.ok(!value.includes('Client-Tower-A'), value);
  });

  it('does not over-redact messages that merely mention an extension', () => {
    // The run must stop at ordinary lower-case message words, or a stray
    // extension would swallow the whole (useful) message.
    const cases = [
      'Could not parse the .ifc header',
      "Cannot read properties of undefined (reading 'toLowerCase')",
      'Failed to fetch dynamically imported module: https://www.ifclite.com/assets/index-B42.js',
    ];
    for (const c of cases) {
      const out = scrubEvent(exceptionEvent(c));
      assert.equal((out?.properties?.$exception_list as { value: string }[])[0].value, c);
    }
  });

  it('redacts in linear time on a hostile message (no catastrophic backtracking)', () => {
    const started = Date.now();
    scrubEvent(exceptionEvent(`${'x-1 '.repeat(5000)}nope`));
    assert.ok(Date.now() - started < 1000, 'redaction regex backtracked');
  });

  it('does NOT delete stack-frame keys that look sensitive', () => {
    // `resolved_name` / `mangled_name` match SENSITIVE_KEY's `name` word.
    // Walking into $exception_list with the key rules would erase every stack
    // trace we have — the whole point of error tracking.
    const out = scrubEvent({
      event: '$exception',
      properties: {
        $exception_list: [{
          type: 'Error',
          value: 'boom',
          stacktrace: { frames: [{ resolved_name: 'appendToBatches', source: '/assets/store.js', line: 4914 }] },
        }],
      },
    } as CaptureEvent);
    const frame = (out?.properties?.$exception_list as {
      stacktrace: { frames: Record<string, unknown>[] };
    }[])[0].stacktrace.frames[0];
    assert.equal(frame.resolved_name, 'appendToBatches');
    assert.equal(frame.source, '/assets/store.js');
    assert.equal(frame.line, 4914);
  });

  it('survives a self-referencing property object', () => {
    const cyclic: Record<string, unknown> = { count: 1 };
    cyclic.self = cyclic;
    const out = scrubEvent({ event: 'custom', properties: { nested: cyclic } } as CaptureEvent);
    assert.equal((out?.properties?.nested as Record<string, unknown>).count, 1);
  });

  it('leaves a null-valued property alone', () => {
    const out = scrubEvent({ event: 'custom', properties: { thing: null } } as CaptureEvent);
    assert.equal(out?.properties?.thing, null);
  });
});

// Issue #1903. A transient user-side network drop reached error tracking at
// `$exception_level: 'error'` with `error_kind: 'unknown'` and no fingerprint —
// indistinguishable from the app being broken. These pin the new contract:
// recognise it, group it, downgrade it, and drop only the provably-offline case.
describe('scrubEvent — benign network failures (#1903)', () => {
  // The exact event shape captured in production: bare WebKit phrasing, no
  // `stacktrace` key at all (a fetch rejection has no frames of ours).
  const safariLoadFailed = (extraProps: Record<string, unknown> = {}): CaptureEvent => ({
    event: '$exception',
    properties: {
      $exception_list: [{ type: 'TypeError', value: 'Load failed', mechanism: { handled: true } }],
      $exception_level: 'error',
      context: 'ifc_model_load',
      ...extraProps,
    },
  });

  it('recognises and fingerprints a bare transport failure', () => {
    const out = scrubEvent(safariLoadFailed());
    assert.equal(out?.properties?.error_kind, 'network_unavailable');
    assert.equal(out?.properties?.$exception_fingerprint, 'ifc-lite:network_unavailable');
  });

  it('downgrades it from error to warning', () => {
    const out = scrubEvent(safariLoadFailed());
    assert.equal(out?.properties?.$exception_level, 'warning');
  });

  it('downgrades a cancellation too', () => {
    const out = scrubEvent(exceptionEvent('The operation was aborted', {
      $exception_level: 'error',
    }));
    assert.equal(out?.properties?.error_kind, 'cancelled');
    assert.equal(out?.properties?.$exception_level, 'warning');
  });

  it('drops the event entirely when the browser reported the user offline', () => {
    assert.equal(scrubEvent(safariLoadFailed({ online: false })), null);
    // Online is kept: a dead CDN edge reads identically to a client, and that
    // one IS ours to fix.
    assert.notEqual(scrubEvent(safariLoadFailed({ online: true })), null);
  });

  it('keeps a real engine-binary failure LOUD (a broken deploy must not be muted)', () => {
    const out = scrubEvent(exceptionEvent(
      'Failed to load the WASM engine binary (ifc-lite_bg.wasm) in ifc-lite-bridge: Load failed',
      { $exception_level: 'error', online: false },
    ));
    assert.notEqual(out, null);
    assert.equal(out?.properties?.error_kind, 'wasm_engine_load');
    assert.equal(out?.properties?.$exception_level, 'error');
    // `wasm` is not a model extension, so the privacy scrub leaves the binary
    // name — which is the whole point of the attribution — intact.
    assert.match(
      (out?.properties?.$exception_list as { value: string }[])[0].value,
      /ifc-lite_bg\.wasm/,
    );
  });

  it('never clobbers a level deliberately chosen at the capture site', () => {
    const out = scrubEvent(safariLoadFailed({ $exception_level: 'fatal' }));
    assert.equal(out?.properties?.$exception_level, 'fatal');
  });

  it('keeps every discriminating capture-site property (key-naming contract)', () => {
    const out = scrubEvent(safariLoadFailed({
      error_type: 'TypeError',
      load_stage: 'engine-init',
      is_retry: false,
      online: true,
    }));
    assert.equal(out?.properties?.context, 'ifc_model_load');
    assert.equal(out?.properties?.error_type, 'TypeError');
    assert.equal(out?.properties?.load_stage, 'engine-init');
    assert.equal(out?.properties?.is_retry, false);
    assert.equal(out?.properties?.online, true);
    // …whereas `error_name` would be deleted outright. This is why the property
    // is `error_type`. Do not rename it.
    const named = scrubEvent(safariLoadFailed({ error_name: 'TypeError' }));
    assert.equal(named?.properties?.error_name, undefined);
  });
});

// ── before_send wiring ──────────────────────────────────────────────────────
// The two skew gates are unit-tested in isolation (chunk-version-skew.test.ts,
// wasm-skew-noise.test.ts). What only a test of `beforeSend` itself can catch is
// the gate being DISCONNECTED from the pipeline: delete the call in analytics.ts
// and every isolated test still passes while the noise silently returns.
describe('beforeSend - chunk-skew gate wiring', () => {
  it('drops an exception captured while a chunk-skew reload is in flight', () => {
    __setChunkReloadPendingForTests(Date.now());
    try {
      // The collateral from #1926/#1938/#1941: an arbitrary TypeError from a
      // consumer still awaiting the chunk that just 404'd.
      const dropped = beforeSend(
        exceptionEvent("Cannot read properties of undefined (reading 'Map')"),
      );
      assert.equal(dropped, null);
    } finally {
      __setChunkReloadPendingForTests(null);
    }
  });

  it('keeps the same exception when no reload is in flight', () => {
    __setChunkReloadPendingForTests(null);
    const kept = beforeSend(
      exceptionEvent("Cannot read properties of undefined (reading 'Map')"),
    );
    assert.notEqual(kept, null);
  });

  it('still runs the scrub on events the gates let through', () => {
    // Ordering guard: a `return null` accidentally placed before scrubEvent, or
    // a gate that short-circuits the pipeline, would lose the tagging that the
    // rest of error tracking is grouped by.
    __setChunkReloadPendingForTests(null);
    const out = beforeSend(exceptionEvent('Geometry worker error: unreachable'));
    assert.equal(out?.properties?.error_kind, 'geometry_worker_crash');
  });

  it('never drops a non-exception event, even mid-reload', () => {
    __setChunkReloadPendingForTests(Date.now());
    try {
      const kept = beforeSend({ event: 'ifc_model_loaded', properties: {} });
      assert.notEqual(kept, null);
    } finally {
      __setChunkReloadPendingForTests(null);
    }
  });
});
