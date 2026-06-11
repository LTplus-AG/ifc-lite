/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import posthogClient from 'posthog-js';

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

if (enabled) {
  posthogClient.init(key as string, {
    api_host: host,
    // No consent UI exists, so never build person profiles for anonymous
    // visitors — events stay anonymous unless an explicit identify() opts
    // a user in.
    person_profiles: 'identified_only',
    capture_pageview: false,
    capture_pageleave: true,
    autocapture: false,
  });
}

const noopAnalytics = {
  capture: () => undefined,
  captureException: () => undefined,
} as unknown as typeof posthogClient;

export const posthog = enabled ? posthogClient : noopAnalytics;
