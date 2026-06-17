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

// Only the PostHog surface the viewer actually calls. Extend this type AND
// the noop fallback together before using a new method at a call site — the
// narrow type is what keeps keyless/Node environments crash-free.
type AnalyticsClient = Pick<typeof posthogClient, 'capture' | 'captureException'>;

// ── Privacy guard ──────────────────────────────────────────────────────────
// ifc-lite opens confidential client building models, so the rule that keeps
// file / pset / property names out of git applies to analytics too: NO event
// may carry a file name, model name, BCF title, free text, or a filesystem
// path — even accidentally from a future call site. `scrubEvent` runs on every
// captured event (including PostHog's own $pageleave / $exception) as a safety
// net on top of the deliberately lean explicit properties.

// Keys whose values tend to be PII / free text / confidential identifiers.
// Matches whole `_`-delimited words, so analytics keys like `data_source`,
// `auto_color_source`, `template_id` or `field` are deliberately left intact.
const SENSITIVE_KEY =
  /(?:^|_)(?:name|filename|model|title|label|path|url|uri|href|email|author|comment|description|message|content|query|sql|expression|psetname|propertyname)(?:$|_)/i;

// PostHog auto-properties that are URLs — keep the route, drop query + hash
// (a share link can encode a model id or token).
const URL_KEYS = new Set<string>([
  '$current_url', '$referrer', '$referring_domain', '$pathname',
  '$initial_current_url', '$initial_referrer', '$initial_referring_domain',
  '$prev_pageview_pathname',
]);

// String values that look like a filesystem path or a building-model file name.
const PATHISH =
  /[\\/][^\\/]*\.(?:ifc|ifcx|ifczip|bcf|bcfzip|glb|gltf|obj|csv|xlsx|pdf|json|step|stp|las|laz)\b|^(?:file|blob):|^[A-Za-z]:\\|\/Users\/|\/home\//i;

const stripQueryAndHash = (value: string): string => {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
};

const scrubProperties = (props: Record<string, unknown> | undefined): void => {
  if (!props) return;
  for (const k of Object.keys(props)) {
    if (SENSITIVE_KEY.test(k)) {
      delete props[k];
      continue;
    }
    const v = props[k];
    if (typeof v === 'string') {
      if (URL_KEYS.has(k)) props[k] = stripQueryAndHash(v);
      else if (PATHISH.test(v)) props[k] = '[redacted]';
    }
  }
};

// ── Noise filter ───────────────────────────────────────────────────────────
// Cesium rejects failed tile / terrain / imagery / ion-asset requests with a
// `RequestErrorEvent` — a plain `{ statusCode, response, responseHeaders }`
// object, not an Error. During continuous globe rendering these fire from deep
// inside Cesium's request scheduler (a tile 403/404/429/timeout), so the geo
// call sites we own (all `try/catch`-wrapped) can't intercept them, and they
// surface as unhandled rejections that PostHog's exception autocapture records.
// They are unactionable third-party network failures, not ifc-lite bugs, so we
// drop the `$exception` event entirely. Match on Cesium's stable property-name
// shape (those three keys), NOT the minified class name (`D_`), which changes
// every build. posthog-js stringifies a non-Error throwable as
// "'<ctor>' captured as exception with keys: <comma-separated own keys>".
const CESIUM_REQUEST_ERROR =
  /captured as exception with keys:(?=[^]*\bstatusCode\b)(?=[^]*\bresponse\b)(?=[^]*\bresponseHeaders\b)/;

const isUnactionableThirdPartyException = (
  event: { event?: string; properties?: Record<string, unknown> },
): boolean => {
  if (event.event !== '$exception') return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list)) return false;
  return list.some(
    (e) =>
      typeof (e as { value?: unknown })?.value === 'string' &&
      CESIUM_REQUEST_ERROR.test((e as { value: string }).value),
  );
};

// `before_send` shape: (event | null) => (event | null). Returning null drops
// the event (noise filter above); otherwise we mutate properties in place,
// which keeps PostHog's event intact. Generic so it satisfies posthog-js's
// BeforeSendFn (CaptureResult) signature.
const scrubEvent = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(
  event: T,
): T | null => {
  if (!event) return event;
  if (isUnactionableThirdPartyException(event)) return null;
  scrubProperties(event.properties);
  return event;
};

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
      // (current + future) before it leaves the browser. See scrubEvent above.
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
