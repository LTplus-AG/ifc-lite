/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { classifyLoadError } from './load-errors.js';
import { isMapWebglInitFailureMessage } from './geo/map-webgl-support.js';

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

// A building-model file name appearing INSIDE a longer string (an exception
// message, typically). PATHISH above answers "is this whole value a path?";
// this one cuts the file name out of surrounding text that is worth keeping.
//
// Real leaked names contain spaces ("16201598 Østraadt Havn - Hovedfil BT1
// Fabian 2.ifc"), so the match cannot stop at whitespace — but it must not run
// away and eat the whole sentence either.
//
// The run therefore extends leftwards across any word EXCEPT the small set of
// English connectives that realistically precede a file name in a message
// ("while loading X", "failed to parse X"). Keying on a stop-list rather than
// on "looks name-ish" is deliberate: an all-lower-case name — `while loading
// acme tower.ifc` — would otherwise keep its client-name prefix, which is
// exactly what this guard exists to prevent. Over-redacting a stray adjacent
// word is the acceptable direction to err in.
//
// Kept in step with PATHISH's extension list above — `json` included because
// IFC5/ifcx models are JSON, so a bare `.json` name can be just as
// confidential as a `.ifc` one.
const MODEL_EXTENSIONS = [
  'ifczip', 'bcfzip', 'ifcx', 'gltf', 'xlsx', 'step', 'json', 'ifc', 'bcf',
  'glb', 'obj', 'csv', 'pdf', 'stp', 'las', 'laz',
];
// Longest-first so `.ifcx` cannot be matched as `.ifc` plus a stray `x`.
const EXT_ALTERNATION = MODEL_EXTENSIONS
  .slice()
  .sort((a, b) => b.length - a.length)
  .join('|');

// Words that end the leftward run. A file name never starts with one, and
// every realistic message wraps the name in one of them.
const NAME_STOPWORDS = [
  'while', 'loading', 'load', 'loads', 'file', 'files', 'model', 'models',
  'open', 'opening', 'read', 'reading', 'parse', 'parsing', 'parsed',
  'import', 'importing', 'imported', 'export', 'exporting', 'exported',
  'process', 'processing', 'processed', 'fetch', 'fetching', 'save', 'saving',
  'for', 'from', 'in', 'at', 'of', 'the', 'to', 'and', 'with', 'on', 'a', 'an',
  'is', 'was', 'be', 'by', 'as', 'it', 'this', 'that',
].join('|');

// The leading \b is load-bearing: without it the run can start in the MIDDLE
// of a stop-word ("loading" -> "oading"), which sails straight past the
// lookahead and defeats the whole stop-list.
//
// Bounded quantifiers throughout - a negative lookahead plus one bounded run,
// never a nested star, so a hostile message cannot force catastrophic
// backtracking.
const FILE_TOKEN = new RegExp(
  String.raw`\b(?:(?!(?:${NAME_STOPWORDS})[ \t])[^\s\\/]{1,64}[ \t]{1,3}){0,12}` +
  String.raw`[^\s\\/]{1,80}\.(?:${EXT_ALTERNATION})\b`,
  'gi',
);

const redactFileTokens = (value: string): string =>
  value.replace(FILE_TOKEN, '[file]');

const stripQueryAndHash = (value: string): string => {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
};

// SDK-owned keys whose nested shape is schema, not payload. `scrubProperties`
// must NOT walk into these with the key-name rules: a stack frame carries
// `resolved_name` / `mangled_name`, which match SENSITIVE_KEY's `name` word and
// would be deleted outright — silently destroying every stack trace. Their
// human-readable strings are handled by `scrubExceptionMessages` instead.
const SDK_STRUCTURED_KEYS = new Set<string>([
  '$exception_list', '$exception_values', '$exception_types',
]);

// Guard against pathological/cyclic payloads: bounded depth, and a seen-set so
// a self-referencing object can't spin forever.
const MAX_SCRUB_DEPTH = 5;

const scrubProperties = (
  props: Record<string, unknown> | undefined,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): void => {
  if (!props) return;
  if (depth > MAX_SCRUB_DEPTH || seen.has(props)) return;
  seen.add(props);
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
    if (SDK_STRUCTURED_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      if (PATHISH.test(v)) props[k] = '[redacted]';
      continue;
    }
    // Recurse: the privacy guard is a net for call sites that don't exist yet,
    // and a nested object was previously invisible to it — a `{ meta: { file:
    // 'Tower-A.ifc' } }` payload sailed straight through. Arrays are walked as
    // index-keyed records so their string members get the same treatment.
    if (v !== null && typeof v === 'object') {
      scrubProperties(v as Record<string, unknown>, depth + 1, seen);
    }
  }
};

// Exception messages are the one place a file name has actually reached error
// tracking in the field (the stream watchdog used to embed `file.name`; fixed
// at the source, but the net has to cover it too). Redact just the file-name
// token so the rest of the message — which is what makes the issue triageable
// — survives.
const scrubExceptionMessages = (
  props: Record<string, unknown> | undefined,
): void => {
  if (!props) return;
  const list = props.$exception_list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      const e = entry as { value?: unknown };
      if (e && typeof e.value === 'string') e.value = redactFileTokens(e.value);
    }
  }
  const values = props.$exception_values;
  if (Array.isArray(values)) {
    props.$exception_values = values.map((v) =>
      typeof v === 'string' ? redactFileTokens(v) : v,
    );
  }
};

// ── Noise filter ───────────────────────────────────────────────────────────
// Every matcher here decides whether to DELETE an event — irreversibly and
// silently, since nothing anywhere records that the event existed. A
// misclassification can at least be re-derived from the stored event; a drop
// cannot be re-derived from anything.
//
// INVARIANT, a property of the whole boolean and not of any one clause: every
// arm matches the exception value AS A WHOLE — anchored at BOTH ends, or
// structural (parse the payload and require the field to BE the token) — so an
// unrelated actionable error that merely QUOTES one of these strings still
// reaches us. #1914 named that hazard while anchoring one arm; three siblings
// were found loose afterwards, each by checking the neighbours of an arm
// somebody had already fixed. A one-end anchor is NOT enough and reads exactly
// like a fix: `^`-only still eats our trailing sentence, `$`-only still eats
// our leading one.
//
// There are TWO axes and an arm has to be tight on both. EXTENT: how much of
// the value the match covers, which is what anchoring buys. IDENTITY: whether
// what matched actually IS the third-party failure. An arm can be exact about
// the shape it matched and vague about whose shape that is — "contains these
// three key names" dropped anything HTTP-ish until `isCesiumRequestError`
// below required Cesium's own-property set exactly. Same defect family,
// different axis, found one review apart.
//
// Adding an arm means constraining both ends AND listing its wording in
// `DROPPED_NOISE_SAMPLES` (./analytics.test.ts), which re-runs every sample
// under four carriers — text before, text after, both sides, and a comma-led
// trailing sentence for the arms that SPLIT the value — and fails unless each
// survives with its own kind, level and fingerprint.
//
// Know what that does and does not buy you. Every wording IN the list is
// protected: loosening any registered arm turns the harness red, including
// arms nobody wrote a dedicated test for. An arm you add and DON'T register is
// invisible to it — a fresh `value.includes(…)` clause with no list entry
// passes everything. Registration is a convention this comment asks for, not a
// gate. Skipping it is how the next instance of this defect gets in.
//
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
// "'<ctor>' captured as exception with keys: <comma-separated own keys>", and
// that IS the whole value — even for an unhandled rejection, whose non-Error
// reason posthog re-coerces through this same path rather than prefixing it.
//
// STRUCTURAL, over the complete value: the ctor token (quoted or bare depending
// on which coercion ran, never spaced), then a key list whose members are
// EXACTLY Cesium's three own properties. Anchoring at `^` alone was not enough and is
// the same half-measure this file exists to remove: the lookaheads scanned the
// rest of the value, so "RequestErrorEvent captured as exception with keys:
// statusCode, response, responseHeaders and our uploader then wrote 0 bytes"
// was dropped with our own trailing sentence inside it. Validating the list
// instead of searching it also leaves posthog free to reorder or respace the
// keys (it sorts and `", "`-joins them today), which a fully literal `^…$`
// would not.
//
// The ctor token is matched but NOT required to read `RequestErrorEvent`, and
// that is not an oversight: in production Cesium's class name is minified —
// the recorded occurrence behind #1175 is literally `'D_'`, which is why that
// issue keyed on the property shape in the first place. Requiring the readable
// name makes this arm dead everywhere it matters (verified: it fails #1175's
// own regression test). The identity constraint that DOES survive minification
// is the exact own-property set, which is what the length check below enforces.
const CESIUM_REQUEST_ERROR_KEYS = ['statusCode', 'response', 'responseHeaders'];

// The whole stringification, with the key list captured for validation rather
// than searched. Bounded runs only: no nested quantifier to backtrack on.
const CAPTURED_WITH_KEYS = /^\S{1,64} captured as exception with keys:[ \t]*(\S[^\n]{0,512})$/;

const isCesiumRequestError = (value: string): boolean => {
  const match = CAPTURED_WITH_KEYS.exec(value);
  if (!match) return false;
  const keys = match[1].split(',').map((key) => key.trim());
  // EXACTLY Cesium's three own properties, not merely "contains" them. Own
  // property names are unique, so length plus containment IS set equality, and
  // set equality is what carries both jobs at once:
  //
  //  identity — containment alone left this arm precise about the shape it
  //    matched and vague about whose shape it was, so any throwable carrying
  //    those three among its keys was deleted as Cesium noise. `{statusCode,
  //    response, responseHeaders}` is a generic HTTP-ish shape, not a
  //    Cesium-unique one, and ours may legitimately carry all three plus its
  //    own request id.
  //  extent — three members that each equal one of three fixed names cannot
  //    also carry a sentence of ours, so the trailing prose case falls out of
  //    the same check. (An explicit "every member is a bare identifier" guard
  //    stood here and was deleted with this change: set equality made it
  //    unable to alter any outcome, and a check that cannot fail is worse than
  //    no check — it reads as protection.)
  if (keys.length !== CESIUM_REQUEST_ERROR_KEYS.length) return false;
  return CESIUM_REQUEST_ERROR_KEYS.every((key) => keys.includes(key));
};

// Microsoft's Outlook SafeLinks / Office link-preview crawler injects a script
// into the page and rejects a promise with this bare string when its own
// bookkeeping misses. It is not our code, carries no stack, and fires only for
// visitors arriving from an Outlook link — 18 occurrences made it the single
// highest-volume "issue" in error tracking, all of it someone else's crawler.
//
// Anchored at BOTH ends over the crawler's complete sentence, so the phrase
// quoted inside a message of OURS survives. The optional leading group is
// posthog's own wrapper for a rejection whose reason was a bare string, which
// is how this one always arrives and why `^` alone will not do; the trailing
// `ParamCount` is optional so a crawler build that omits it still drops.
// Everything before it is attested verbatim in our recorded occurrences.
const OUTLOOK_SAFELINK_NOISE =
  /^(?:Non-Error promise rejection captured with value:\s*)?Object Not Found Matching Id:\s*\d+,\s*MethodName:\s*\w{1,64}(?:,\s*ParamCount:\s*\d+)?\.?\s*$/i;

// MapLibre cannot get a WebGL context: `_setupPainter()` throws either a bare
// "Failed to initialize WebGL" or that message wrapped in a JSON blob carrying
// the driver's `statusMessage` and `type: 'webglcontextcreationerror'`. The
// LocationMap now probes first, catches the construction, and reports the
// condition ONCE as a handled exception (see lib/geo/map-webgl-support.ts), so
// this is not the fix — it is the net under the one path we genuinely cannot
// catch: MapLibre restoring a lost context calls `_setupPainter()` again from
// inside a DOM event listener, where no try/catch of ours is on the stack.
//
// The condition is a property of the user's GPU (missing OES_packed_depth_
// stencil, or a GPU process that could not serve a context), unactionable in
// our code and unfixable by the user beyond reloading. Matched on MapLibre's
// stable message + the `webglcontextcreationerror` token, never on a minified
// name — the same discipline as the Cesium matcher above. Deliberately narrow:
// a WebGL failure that is ever actionable must not be silently dropped.
//
// Both shapes come from `isMapWebglInitFailureMessage`, imported rather than
// restated so MapLibre's wordings keep ONE home. #1914 anchored the bare
// message and left the payload arm a bare `"type": "webglcontextcreationerror"`
// substring test, so an uncaught `Upload failed: driver shim logged
// {"type":"webglcontextcreationerror"} while retrying` was deleted outright and
// no record kept. That arm is now structural: the message must PARSE as JSON
// whose `type` field IS the token and whose `message` is MapLibre's own
// anchored wording — the shape v5 actually threw.
//
// The set stays exactly MapLibre's two throw shapes and is NOT widened to v6's
// `WebGL2 is required to display this map`: #2354 keeps that family (classified
// `webgl_unavailable`, one fingerprint, downgraded to `warning`) precisely so
// the condition stays queryable, and dropping more of it would undo that.

// The browser's opaque cross-origin error: `window.onerror` reports literally
// "Script error." with no file, line, or stack when a script from another
// origin throws (an extension, a translated page, an ISP-injected script). It
// is information-free by construction — and PostHog's own ingestion fragments
// it into hundreds of orphaned issues. Only dropped when there are NO frames:
// if a "Script error." ever arrives with a usable stack, it is ours to fix.
const OPAQUE_CROSS_ORIGIN = /^Script error\.?$/i;

// The browser dispatches this as a bare ErrorEvent on `window` whenever a
// ResizeObserver callback resized something, so a notification round has to
// be deferred to the next frame — the spec's documented, intentionally
// non-fatal condition, not a hung page or an infinite loop. It fires from
// textbook-correct observer code (this repo's dozen ResizeObserver call
// sites in Viewport.tsx, Drawing2DCanvas.tsx, GanttTimeline.tsx,
// AnnotationLayer.tsx, etc. were audited for #2120 and none mutates the
// element it observes), which is exactly why it surfaces as a warning-shaped
// message rather than throwing a real Error: no Error object, no file/line,
// no stack — the same opaque, information-free shape as "Script error."
// above, so it gets the same `frameCount === 0` gate: if this message ever
// arrives WITH a stack, something in our code threw it deliberately, and
// that is ours to look at, not noise. Anchored to the two known browser
// wordings (Chromium's current text and the older/WebKit "loop limit
// exceeded"), never a substring test — dropping is irreversible.
const RESIZE_OBSERVER_LOOP =
  /^ResizeObserver loop (?:completed with undelivered notifications\.?|limit exceeded)$/i;

const frameCount = (e: unknown): number => {
  const frames = (e as { stacktrace?: { frames?: unknown } } | null)
    ?.stacktrace?.frames;
  return Array.isArray(frames) ? frames.length : 0;
};

// posthog-js stamps `mechanism.handled: false` on anything it autocaptured from
// `onerror` / `onunhandledrejection`, and `true` on an explicit
// `captureException`. Only the autocaptured ones are "nobody is dealing with
// this"; a deliberate capture is a report we asked for and must never be
// dropped by a message matcher aimed at the uncaught form of the same failure.
const isUnhandled = (e: unknown): boolean =>
  (e as { mechanism?: { handled?: unknown } } | null)?.mechanism?.handled === false;

const isUnactionableThirdPartyException = (
  event: { event?: string; properties?: Record<string, unknown> },
): boolean => {
  if (event.event !== '$exception') return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list)) return false;
  return list.some((entry) => {
    const value = (entry as { value?: unknown })?.value;
    if (typeof value !== 'string') return false;
    if (isCesiumRequestError(value)) return true;
    if (OUTLOOK_SAFELINK_NOISE.test(value)) return true;
    // Scoped to the UNCAUGHT form only: the LocationMap's own once-per-session
    // handled report carries the same message and has to survive, otherwise
    // this rule would blind us to the very condition it exists to de-noise.
    if (isMapWebglInitFailureMessage(value) && isUnhandled(entry)) return true;
    if (OPAQUE_CROSS_ORIGIN.test(value.trim()) && frameCount(entry) === 0) return true;
    if (RESIZE_OBSERVER_LOOP.test(value.trim()) && frameCount(entry) === 0) return true;
    return false;
  });
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

// ── Wasm trap attribution (#1196, #2527) ────────────────────────────────────
// A Rust panic in the wasm engine reaches JS as `RuntimeError: unreachable`
// (`panic = "abort"`), so the second bare-trap PostHog issue in a row arrived
// carrying nothing to triage — the panic hook had printed the real location to
// the console, but the console is not captured. The engine's panic hook
// (rust/wasm-bindings/src/utils.rs) now stashes the panic's SOURCE LOCATION on
// the realm's global as `__ifclite_wasm_panic = { location, at }`; here — the
// same realm, since posthog runs where the main-thread trap surfaced — it is
// attached to the trap's exception event as `wasm_panic_location`.
//
// Only the source location ever travels: the panic's payload message can embed
// model-derived text, so it stays console-only. The stash is consumed on
// attach, ignored when stale (a trap surfaces within milliseconds of its
// panic; anything older is a suppressed trap that must not mislabel a later
// one), and left in place for a non-trap exception that merely interleaved.
// Deliberately a property, never an `error_kind` or fingerprint — #1196
// settled that bare traps stay ungrouped (see load-errors.ts).
const WASM_PANIC_STASH_KEY = '__ifclite_wasm_panic';
const WASM_PANIC_STASH_TTL_MS = 60_000;

// Trap identity: the stable `.type` (the spec fixes `RuntimeError` for every
// wasm trap) or, on the string-only path, the engine's trap phrasings.
const WASM_TRAP_TEXT =
  /\bunreachable\b|\bRuntimeError\b|memory access out of bounds|index out of bounds|indirect call to null|integer (?:overflow|divide by zero)|call stack exhausted/i;

const isWasmTrapException = (props: Record<string, unknown>): boolean => {
  const list = props.$exception_list;
  if (
    Array.isArray(list) &&
    list.some((e) => (e as { type?: unknown } | null)?.type === 'RuntimeError')
  ) {
    return true;
  }
  const message = exceptionMessage(props);
  return message !== undefined && WASM_TRAP_TEXT.test(message);
};

const attachWasmPanicLocation = (
  event: { event?: string; properties?: Record<string, unknown> },
): void => {
  if (event.event !== '$exception' || !event.properties) return;
  const g = globalThis as Record<string, unknown>;
  const stash = g[WASM_PANIC_STASH_KEY];
  if (typeof stash !== 'object' || stash === null) return;
  if (!isWasmTrapException(event.properties)) return;
  // Consume-once for ANY trap exception — stale or malformed included — so one
  // stash can never label two traps.
  delete g[WASM_PANIC_STASH_KEY];
  const { location, at } = stash as { location?: unknown; at?: unknown };
  if (typeof location !== 'string' || location === '') return;
  if (typeof at !== 'number' || !(Date.now() - at <= WASM_PANIC_STASH_TTL_MS)) return;
  // A location deliberately set at the capture site wins.
  if (typeof event.properties.wasm_panic_location === 'string') return;
  event.properties.wasm_panic_location = location;
};

// ── Issue grouping ──────────────────────────────────────────────────────────
// PostHog groups exceptions into issues by hashing the exception type + message
// (+ stack) unless the client supplies `$exception_fingerprint`, which takes
// priority over every server-side rule. Our recognised failure families embed
// volatile numbers in their message — "stalled after 40000ms. Last rendered
// meshes: 120070." — so every distinct mesh count minted its OWN issue: one
// real bug arrived as eleven separate issues (and eleven GitHub issues) in a
// single retention window, which is exactly the "same problem, one fix" case
// PostHog documents custom fingerprints for.
//
// A constant message is not enough on its own, which is what #2354 showed: the
// minimap's WebGL report is one fixed string per reason, yet it minted a fresh
// issue on each deploy, because the stack that feeds the default hash names the
// hashed bundle it came from (`main-DnUx64at.js`, then `index-B0OhdiDw.js`, …).
// Four issues, one benign condition. A fingerprint is the only thing that
// survives a release.
//
// Scoped deliberately to the families `classifyLoadError` recognises. An
// unrecognised exception keeps PostHog's default per-message grouping, so we
// never over-group unrelated failures into one meaningless bucket. The volatile
// detail is not lost — it stays in the message and in the event's properties,
// both still queryable within the issue.
const stampFingerprint = (
  event: { event?: string; properties?: Record<string, unknown> },
): void => {
  if (event.event !== '$exception' || !event.properties) return;
  // Never override a fingerprint chosen at the capture site.
  if (typeof event.properties.$exception_fingerprint === 'string') return;
  const kind = event.properties.error_kind;
  if (typeof kind !== 'string' || kind === 'unknown') return;
  event.properties.$exception_fingerprint = `ifc-lite:${kind}`;
};

// ── Benign-vs-real severity ─────────────────────────────────────────────────
// posthog-js stamps every captured exception `$exception_level: 'error'`, which
// says "the app is broken". Two of our recognised families are not: a dropped
// connection and a cancellation are user-side and transient — issue #1903 was
// one user's cold-cache first visit whose engine download blipped, and whose
// session went on to load a model successfully 22 s later.
//
// They are DOWNGRADED, not dropped, so they stay queryable (a spike in
// `network_unavailable` is a real signal about a CDN or a region) while no
// longer competing with genuine breakage on an error-level issue list. Only a
// level of `error` is rewritten, so a capture site that deliberately chose
// `fatal` / `warning` / `info` is never clobbered. `wasm_engine_load` is
// pointedly NOT in this set: a rotated or 404ing engine binary means the deploy
// is broken for everyone and must stay loud.
//
// `webgl_unavailable` joins them for the same reason, on stronger evidence
// (#2354). It is not a failure at all in the sense `error` claims: the minimap
// probes for a WebGL context, the device refuses one, and `LocationMap` paints
// its fallback with the coordinate readout, place search, the external map
// links and KMZ export all still working. Nothing the user or a code change can
// alter — the reported occurrences are a device whose GPU is missing an
// extension or whose GPU process could not serve a second context. It stays
// captured and queryable (with `map_unavailable_reason` and `webgl_status`
// intact), just not competing with real breakage on an error-level list.
//
// three.js's `THREE.WebGLRenderer: Error creating WebGL context.` was pointedly
// NOT in this bucket while nothing caught it: it threw out of an `/mcp` mount
// effect and took the React tree down, which is breakage and had to stay
// error-level. #2401 removed that premise — both `/mcp` scenes now mount behind
// `useThreeScene`, degrade to a static panel, and report once as a HANDLED
// exception — so #2458 folds those wordings into `webgl_unavailable` (see
// `isThreeContextRefusal` in ./webgl-unavailable.ts) and they inherit this severity
// with it. If a WebGLRenderer is ever constructed outside that guard again, the
// throw would arrive here benign; the guard is the thing keeping this honest.
const BENIGN_ERROR_KINDS = new Set<string>([
  'network_unavailable', 'cancelled', 'webgl_unavailable',
]);

const downgradeBenignExceptions = (
  event: { event?: string; properties?: Record<string, unknown> },
): void => {
  if (event.event !== '$exception' || !event.properties) return;
  const kind = event.properties.error_kind;
  if (typeof kind !== 'string' || !BENIGN_ERROR_KINDS.has(kind)) return;
  if (event.properties.$exception_level !== 'error') return;
  event.properties.$exception_level = 'warning';
};

// The browser told us it was offline when the fetch failed, so the failure is
// definitionally user-side and there is nothing on our end to act on. Requires
// ALL THREE signals: `online === false` alone could accompany an unrelated bug,
// and `network_unavailable` alone may well be ours (a dead CDN edge reads the
// same to an online client). Capture sites set `online` from `navigator.onLine`.
//
// The third is the frameless gate, and it closes a case that was live rather
// than hypothetical (#2410). `network_unavailable`'s doc comment in
// ./load-errors.ts rests on these strings originating INSIDE `fetch()` and so
// arriving with an EMPTY stack — but nothing enforced that, and the reproduction
// confirmed the drop fired just as readily on an exception carrying our own
// frames. A stack of ours is positive evidence that the throw happened in our
// code, whatever `navigator.onLine` said at the time, and deleting that is
// irreversible. Same `frameCount === 0` shape the two noise-filter arms above
// use, for the same reason.
//
// An ABSENT or empty `$exception_list` keeps the event: an irreversible drop
// must require positive evidence of its premise, never the mere absence of
// counter-evidence. The production shape from #1903 — one entry, no
// `stacktrace` key at all — is frameless and still drops.
const isFramelessException = (list: unknown): boolean =>
  Array.isArray(list) && list.length > 0 && list.every((entry) => frameCount(entry) === 0);

const isOfflineNetworkFailure = (
  event: { event?: string; properties?: Record<string, unknown> },
): boolean =>
  event.event === '$exception' &&
  event.properties?.error_kind === 'network_unavailable' &&
  event.properties?.online === false &&
  isFramelessException(event.properties?.$exception_list);

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
  // Order matters: tag first (stampFingerprint reads `error_kind`), then redact
  // messages, then walk the properties. Message redaction runs BEFORE tagging
  // would be wrong — `classifyLoadError` matches on the stable prefix, but
  // keeping the raw text until after classification means a future matcher can
  // still rely on the original wording.
  tagErrorKind(event);
  stampFingerprint(event);
  // Before the property walk, so the attached location passes the same
  // path-redaction net as every other property.
  attachWasmPanicLocation(event);
  // After tagging (both read `error_kind`) and before the property walk, which
  // may delete keys these read.
  if (isOfflineNetworkFailure(event)) return null;
  downgradeBenignExceptions(event);
  scrubExceptionMessages(event.properties);
  scrubProperties(event.properties);
  return event;
};
