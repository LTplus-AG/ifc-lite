/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import posthogClient from 'posthog-js';
import { isAnalyticsOptedOut, persistAnalyticsOptOut } from './analytics-consent.js';
import { scrubEvent } from './analytics-scrub.js';
import { scrubUiEvent, type UiEventName, type UiEventProperties } from './analytics-ui-events.js';
import { scrubExportEvent, type ExportCompletedProperties } from './analytics-export-events.js';
import { shouldSuppressWasmSkewNoise } from './wasm-version-skew.js';
import { shouldSuppressChunkSkewNoise } from './chunk-version-skew.js';
import { shouldSuppressForeignScriptNoise } from './foreign-script-noise.js';

// `before_send` gate: drop the noise from an auto-recovered version skew - the
// tab reloads onto fresh assets, so the captured exception describes a failure
// the user never actually hits. Two sibling gates, because the two skews are
// detected differently: the wasm one by the error's own signature
// (shouldSuppressWasmSkewNoise), the JS/CSS chunk one by the reload we have
// already committed to (shouldSuppressChunkSkewNoise) - a failed chunk's
// collateral shares no vocabulary with its cause. A third gate drops what was
// never ours at all: a throw whose every frame belongs to an injected
// extension / user script (shouldSuppressForeignScriptNoise). Then run the privacy/tagging
// scrub on everything that remains. Kept here rather than inside scrubEvent so
// analytics-scrub.ts stays dependency-free (no @ifc-lite/geometry import) and
// independently unit-testable.
// Exported for ./analytics.test.ts and ./foreign-script-noise.test.ts. Only a
// test of THIS function can catch a gate being disconnected from the pipeline,
// which is the failure that would silently restore the noise.
//
// The three gates are NOT tested the same way, and the difference is
// deliberate. The two skew gates have isolated unit tests of their own
// (./wasm-skew-noise.test.ts, ./chunk-version-skew.test.ts) plus wiring tests
// here. The foreign-script gate is observed ONLY through this function, and
// adding an isolated test that imports ./foreign-script-noise.js directly would
// break something: `scripts/check-test-revert-oracle.mjs` reverts the
// production change and requires the changed tests to fail BY ASSERTION, and
// the #4939 fix ADDS that module - so a test importing it dies with
// ERR_MODULE_NOT_FOUND under the revert, no assertion runs, and the oracle
// reports REVERT-BROKE-BUILD. This file is modified rather than added, so under
// the revert it still loads with the gate absent and the assertions fail
// properly. Please do not "fix" that test by importing the module.
export const beforeSend = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(event: T): T | null => {
  if (isAnalyticsOptedOut()) return null;
  if (shouldSuppressWasmSkewNoise(event)) return null;
  if (shouldSuppressChunkSkewNoise(event)) return null;
  // A third sibling gate, on attribution rather than on a message or a reload:
  // an injected extension / user script throwing on our `window` is not ours to
  // fix (#4939). Lives in its own module for the same reason as the other two.
  if (shouldSuppressForeignScriptNoise(event)) return null;
  // UI interaction events (#5618) keep only their declared id properties.
  return scrubEvent(scrubExportEvent(scrubUiEvent(event)));
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
      // Events stay anonymous unless an explicit identify() opts a user in.
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
    if (isAnalyticsOptedOut()) posthogClient.opt_out_capturing();
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

/** All explicit capture sites use this facade, so the setting takes effect immediately. */
export function consentAwareAnalyticsClient(target: AnalyticsClient): AnalyticsClient {
  return {
    capture: (event, properties, options) =>
      isAnalyticsOptedOut() ? undefined : target.capture(event, properties, options),
    captureException: (error, additionalProperties) =>
      isAnalyticsOptedOut() ? undefined : target.captureException(error, additionalProperties),
  };
}

export const posthog: AnalyticsClient = consentAwareAnalyticsClient(client ?? noopAnalytics);

/** Persist the preference and update PostHog's automatic capture policy. */
export function setAnalyticsOptOut(value: boolean): void {
  persistAnalyticsOptOut(value);
  if (!enabled || !client) return;
  try {
    if (value) posthogClient.opt_out_capturing();
    else posthogClient.opt_in_capturing({ captureEventName: false });
  } catch (error) {
    console.warn('[analytics] could not update PostHog consent', error);
  }
}

/**
 * The one entry point for UI interaction events (#5618). The event name and
 * its property keys are checked against `UiEventProperties` at compile time,
 * so a typo'd name or an undeclared property fails typecheck; `scrubUiEvent`
 * enforces the same contract again before the event leaves the browser.
 */
export function trackUiEvent<E extends UiEventName>(event: E, properties: UiEventProperties[E]): void {
  posthog.capture(event, properties);
}

/**
 * The one path for surfacing a load failure to the user (#5618, #5851).
 * `message` goes on the store, where the in-viewport load-error card reads
 * it; `code` is a fixed id (never the message itself), so `error_shown`
 * stays a closed, scrubber-safe vocabulary. Every load path — `useIfcLoader`,
 * every federated IFCX path in `useIfcFederation`, and the `?model=`
 * autoload — calls this one function, so there is never a second error path.
 *
 * `setError`/`setLastLoadRetry` are passed in rather than read from
 * `@/store` here: every store slice this module could reach transitively
 * (e.g. `uiSlice` → `store/uiTelemetry.ts` → this file's own `trackUiEvent`)
 * would make `@/store` importing back into this file a real circular
 * import, not just a theoretical one — it broke store initialization
 * (`Cannot access 'createChartSlice' before initialization`) the one time
 * it was tried. Every caller already has both setters from its own
 * `useViewerStore` binding.
 *
 * `retry` is REQUIRED, not optional, on purpose (#5851 review): the card's
 * Retry button is exactly `store.lastLoadRetry`, and a call site that could
 * set an error without saying what Retry does would leave a STALE retry
 * from whatever the previous error was — this is the bug the required
 * parameter exists to make impossible. Pass a thunk that re-runs the same
 * attempt (same File, URL, or buffers), or `null` when nothing can usefully
 * be retried (the card then renders without a Retry button).
 */
export function showLoadError(
  setError: (message: string) => void,
  setLastLoadRetry: (retry: (() => void) | null) => void,
  message: string,
  code: string,
  retry: (() => void) | null,
): void {
  setError(message);
  setLastLoadRetry(retry);
  trackUiEvent('error_shown', { code, surface: 'load_error' });
}

/** The sole capture path for completed exports (#5844). */
export function trackExportCompleted(properties: ExportCompletedProperties): void {
  posthog.capture('export_completed', properties);
}
