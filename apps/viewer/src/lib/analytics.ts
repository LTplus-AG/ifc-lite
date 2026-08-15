/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import posthogClient from 'posthog-js';
import { scrubEvent } from './analytics-scrub.js';
import { shouldSuppressWasmSkewNoise } from './wasm-version-skew.js';
import { shouldSuppressChunkSkewNoise } from './chunk-version-skew.js';

// `before_send` gate: drop the noise from an auto-recovered version skew - the
// tab reloads onto fresh assets, so the captured exception describes a failure
// the user never actually hits. Two sibling gates, because the two skews are
// detected differently: the wasm one by the error's own signature
// (shouldSuppressWasmSkewNoise), the JS/CSS chunk one by the reload we have
// already committed to (shouldSuppressChunkSkewNoise) - a failed chunk's
// collateral shares no vocabulary with its cause. Then run the privacy/tagging
// scrub on everything that remains. Kept here rather than inside scrubEvent so
// analytics-scrub.ts stays dependency-free (no @ifc-lite/geometry import) and
// independently unit-testable.
// Exported for ./analytics.test.ts. Both gates are unit-tested in isolation, but
// only a test of THIS function can catch the gate being disconnected from the
// pipeline, which is the failure that would silently restore the noise.
export const beforeSend = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(event: T): T | null => {
  if (shouldSuppressWasmSkewNoise(event)) return null;
  if (shouldSuppressChunkSkewNoise(event)) return null;
  return scrubEvent(event);
};

// PostHog's own `DOMExceptionCoercer` (posthog-js -> @posthog/core) does
// exactly this before an exception ever leaves the browser:
//
//   const hasStack = isString(err.stack);
//   return { ..., stack: hasStack ? err.stack : undefined, ... };
//
// — verified by reading @posthog/core's dom-exception-coercer.js. So any
// DOMException reaching `captureException` with no `.stack` is symbolicated
// as zero frames, full stop; no amount of sourcemap upload changes that,
// because there is nothing for PostHog to resolve.
//
// And a JS-constructed `DOMException` commonly HAS no `.stack`: confirmed by
// probing real engines with Playwright (both WebKit 26.5 and Chromium) —
// `new DOMException(msg, name)` is `instanceof Error` but `'stack' in err` is
// false in both. Contrast a DOMException the browser itself throws as part of
// a native binding failure (e.g. `structuredClone`'s `DataCloneError`), which
// DOES get a stack in both engines. Which path `GPUDevice.createTexture`'s
// `InvalidStateError` takes isn't independently verifiable without a live
// WebGPU device, but the fix below is correct either way: it only touches
// errors that already have no usable stack, so it can only add frames PostHog
// would otherwise have dropped, never disturb a real one.
//
// This is the root cause behind issues #2229/#2230 ("payload carries no
// stacktrace") for any call site whose caught value is a DOMException (GPU
// upload failures, WebGL context loss, AbortError-shaped cancellations, …).
//
// The fix: at the capture boundary, if the value handed to `captureException`
// is an `Error` (DOMException included — it's `instanceof Error`) with no
// usable `.stack`, synthesize one by throwing/catching fresh right here. That
// can't recover the original throw site, but every call site that reaches
// this (gpu-upload-guard.ts, useIfcLoader.ts, LocationMap.tsx, …) reports
// synchronously from inside its own catch block, so the synthesized frames
// are the same call chain minus the innermost native frame — real,
// sourcemap-resolvable file/line/column instead of the zero frames PostHog's
// coercer would otherwise emit. See ./analytics.test.ts for the RED/GREEN
// pair pinning this against posthog-js's actual coercer behavior.
export function ensureCapturableStack(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  if (typeof err.stack === 'string' && err.stack.length > 0) return err;
  const withStack = new Error(err.message);
  withStack.name = err.name;
  // V8 only: drops this function's own frame so the top of the synthesized
  // stack is the real caller. A no-op (and harmless) everywhere else — those
  // engines already excluded native-call frames from `new Error()`'s capture.
  const capture = (Error as unknown as { captureStackTrace?: (target: object, ctor: unknown) => void }).captureStackTrace;
  if (typeof capture === 'function') capture(withStack, ensureCapturableStack);
  return withStack;
}

// `import.meta.env` is undefined under the Node test runner (no Vite define
// plugin), and this module is loaded transitively by most viewer tests. The
// optional chaining keeps the module-top-level read safe there — do NOT drop
// it (same contract as cesiumSlice.ts).
const key = import.meta.env?.VITE_POSTHOG_KEY;
const host = import.meta.env?.VITE_POSTHOG_HOST;

// posthog-js is browser-only: under Node its methods aren't callable, and
// even in the browser calling capture() without init() logs errors. The
// no-op fallback keeps every call site guard-free in tests and in builds
// without a PostHog key.
const enabled = Boolean(key && host) && typeof posthogClient?.init === 'function';

// Only the PostHog surface the viewer actually calls. Extend this type AND
// the noop fallback together before using a new method at a call site — the
// narrow type is what keeps keyless/Node environments crash-free.
type AnalyticsClient = Pick<typeof posthogClient, 'capture' | 'captureException'>;

let client: AnalyticsClient | null = null;
if (enabled) {
  try {
    posthogClient.init(key as string, {
      api_host: host,
      // No consent UI exists, so never build person profiles for anonymous
      // visitors — events stay anonymous unless an explicit identify() opts
      // a user in.
      person_profiles: 'identified_only',
      capture_pageview: false,
      capture_pageleave: true,
      autocapture: false,
      // Strip any file name / model name / path / free text from every event
      // (current + future) before it leaves the browser, drop unactionable
      // third-party noise, and tag the geometry error family. See scrubEvent
      // in ./analytics-scrub.ts.
      before_send: beforeSend,
    });
    // Register build attribution as super-properties so every event (incl.
    // ifc_model_loaded) carries the deploy it was served from — this is what
    // lets field perf regressions be pinned to a specific release. Guarded with
    // typeof for the Node test runner, where the Vite `define` constants that
    // back __APP_VERSION__/__BUILD_SHA__ are not injected.
    posthogClient.register({
      app_version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
      app_build_sha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'dev',
    });
    client = {
      capture: posthogClient.capture.bind(posthogClient),
      // Normalize away the DOMException-with-no-.stack case (see
      // ensureCapturableStack above) before it reaches posthog-js's coercer.
      captureException: (err, additionalProperties) =>
        posthogClient.captureException(ensureCapturableStack(err), additionalProperties),
    };
  } catch (err) {
    console.warn('[analytics] PostHog init failed; analytics disabled', err);
  }
}

const noopAnalytics: AnalyticsClient = {
  capture: () => undefined,
  captureException: () => undefined,
};

export const posthog: AnalyticsClient = client ?? noopAnalytics;
