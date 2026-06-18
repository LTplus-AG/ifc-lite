/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import posthogClient from 'posthog-js';
import { scrubEvent } from './analytics-scrub.js';

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
      before_send: scrubEvent,
    });
    client = posthogClient;
  } catch (err) {
    console.warn('[analytics] PostHog init failed; analytics disabled', err);
  }
}

const noopAnalytics: AnalyticsClient = {
  capture: () => undefined,
  captureException: () => undefined,
};

export const posthog: AnalyticsClient = client ?? noopAnalytics;
