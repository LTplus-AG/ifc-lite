/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { classifyLoadError } from './load-errors.js';

// PostHog `before_send` pipeline: the single gate every captured event passes
// through before it leaves the browser. Kept dependency-free (no posthog-js) so
// the privacy + tagging contract is unit-testable without the browser SDK; the
// client wiring lives in analytics.ts.

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
    const v = props[k];
    // URL_KEYS must be checked BEFORE SENSITIVE_KEY: keys like `$current_url`
    // match SENSITIVE_KEY's `url` word, so without this they'd be deleted
    // outright instead of having their query/hash stripped — losing the route
    // we intend to keep (see the URL_KEYS comment above).
    if (URL_KEYS.has(k)) {
      if (typeof v === 'string') props[k] = stripQueryAndHash(v);
      continue;
    }
    if (SENSITIVE_KEY.test(k)) {
      delete props[k];
      continue;
    }
    if (typeof v === 'string' && PATHISH.test(v)) props[k] = '[redacted]';
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

// ── Error-family tagging ─────────────────────────────────────────────────────
// The geometry pipeline surfaces a recurring family of resource-exhaustion
// failures on heavy models (WASM OOM, the worker pool's "Geometry worker …"
// crashes, the stream watchdog) plus transient engine-load failures. Many reach
// error tracking RAW — either as uncaught exceptions PostHog autocaptures or via
// explicit captureException — so each new minified message spawns its own
// one-off error group (and a public GitHub issue). Stamping a stable
// `error_kind` from the exception's message lets the *recognised* family be
// filtered, grouped, and suppressed centrally instead of triaged one by one.
// Unrecognised exceptions (`unknown`) are left untagged so an unrelated app
// failure is never mislabelled as a geometry/load error. See ./load-errors.ts.
const exceptionMessage = (
  props: Record<string, unknown> | undefined,
): string | undefined => {
  if (!props) return undefined;
  const list = props.$exception_list;
  if (Array.isArray(list)) {
    for (const e of list) {
      const v = (e as { value?: unknown })?.value;
      if (typeof v === 'string' && v) return v;
    }
  }
  const values = props.$exception_values;
  if (Array.isArray(values) && typeof values[0] === 'string') return values[0] as string;
  return undefined;
};

const tagErrorKind = (
  event: { event?: string; properties?: Record<string, unknown> },
): void => {
  if (event.event !== '$exception' || !event.properties) return;
  // Don't clobber an explicit kind set at the capture site.
  if (typeof event.properties.error_kind === 'string') return;
  const message = exceptionMessage(event.properties);
  if (message === undefined) return;
  const kind = classifyLoadError(message);
  // Only tag recognised families — never stamp `unknown` onto an unrelated
  // exception (that would mislabel it as a triaged load error).
  if (kind === 'unknown') return;
  event.properties.error_kind = kind;
};

// `before_send` shape: (event | null) => (event | null). Returning null drops
// the event (noise filter above); otherwise we mutate properties in place,
// which keeps PostHog's event intact. Generic so it satisfies posthog-js's
// BeforeSendFn (CaptureResult) signature.
export const scrubEvent = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(
  event: T,
): T | null => {
  if (!event) return event;
  if (isUnactionableThirdPartyException(event)) return null;
  tagErrorKind(event);
  scrubProperties(event.properties);
  return event;
};
