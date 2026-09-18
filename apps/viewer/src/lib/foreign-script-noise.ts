/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drop autocaptured exceptions thrown by scripts that are not ours (#4939).
 *
 * A browser extension's content script, a WKUserScript, or a translated page's
 * injected helper runs in the page's realm, on the page's `window`. When it
 * throws, `window.onerror` fires in OUR document, posthog-js autocaptures it,
 * and error tracking mints an issue against the viewer for code we do not ship
 * and cannot fix.
 *
 * #4939 is exactly that. Recorded occurrence, ONE event in ONE Safari 17.6 /
 * macOS session on `https://www.ifclite.com/`, with a sibling 12 ms later:
 *
 *   TypeError: undefined is not an object (evaluating 'tab.id')
 *     ? @ webkit-masked-url://hidden/:21622:17
 *   TypeError: undefined is not an object (evaluating 'response.type')
 *     ? @ webkit-masked-url://hidden/:4273:15
 *
 * `tab.id` and `response.type` are the WebExtension API's own shapes — a
 * content script reading `browser.tabs` results, then the reply from a
 * `runtime.sendMessage` round trip — and the pair firing milliseconds apart in
 * two differently-sized foreign bundles is that handshake failing, not one of
 * our components rendering. The viewer's own `tab.id` sites cannot produce it:
 * `RibbonToolbar` maps a module-level `RIBBON_TABS` literal and
 * `WidgetRenderer` maps tabs already validated by `@ifc-lite/extensions`'
 * widget schema, and a throw from either would carry a frame in our bundle
 * under `https://www.ifclite.com/assets/`, which neither of these does.
 *
 * ## Why the existing gates let it through
 *
 * `analytics-scrub.ts` already drops the opaque cross-origin shapes
 * ("Script error.", the ResizeObserver loop notice) — but both are gated on
 * `frameCount === 0`, because those arrive information-free. WebKit does not
 * report a foreign script as frameless. It reports a real frame and masks only
 * the URL, as the literal string `webkit-masked-url://hidden/`, so the
 * frame-count gate does not fire and the event ships.
 *
 * posthog-js has already made the same judgement about that prefix one step
 * earlier. In the version this repo installs — `@posthog/core@1.50.5`, the only
 * copy in the tree, via `posthog-js@^1.426.3` — `createFrame` sets
 *
 *   in_app: !!filename && !filename.startsWith(MASKED_URL_PREFIX)
 *             && filename !== ANONYMOUS_FILENAME
 *
 * with `MASKED_URL_PREFIX = 'webkit-masked-url://'` (verified verbatim in
 * `dist/error-tracking/parsers/base.mjs`). So posthog knows the frame is not
 * the app's. It just captures the event anyway. This gate is that knowledge
 * applied to the whole event.
 *
 * The gate deliberately does NOT read `in_app`, and must not be "simplified"
 * to. Two reasons. It is upstream's derived opinion rather than evidence, and
 * it is not stable across versions: later `@posthog/core` releases replace that
 * expression with an `isAppFilename()` allowlist of app URL schemes, which
 * reaches the same verdict for a masked URL by a different route and could
 * reach a different one for something else. And `in_app: false` is far broader
 * than "foreign" even in the installed version — an `<anonymous>` frame or a
 * frame with no filename also gets it. Reading the frame's own URL keeps this
 * decision ours and keeps it pinned to the evidence in the payload.
 *
 * ## Identity, not wording
 *
 * The scrub module's noise arms match exception MESSAGES and therefore have to
 * be anchored at both ends so a message of ours that merely quotes one cannot
 * be eaten. This gate never looks at the message: it asks who the code was.
 * Every frame of every exception in the event must carry a foreign script URL,
 * and the event must be one posthog AUTOCAPTURED (`mechanism.handled ===
 * false`) rather than one we asked for by calling `captureException`. If a
 * single frame is ours, the throw crossed into our code and stays — an
 * extension that breaks the viewer through our own call stack is still our
 * problem to see.
 *
 * Frames are required to be PRESENT (an empty or absent stack is not evidence
 * of anything, and the frameless shapes already have their own gates in
 * `analytics-scrub.ts`), which keeps the same rule the scrub module states: an
 * irreversible drop needs positive evidence of its premise.
 */

/**
 * URL schemes a script can only have if it was injected into the page from
 * outside the deployment.
 *
 * - `webkit-masked-url:` — WebKit's placeholder for a script whose real URL it
 *   deliberately will not disclose: Safari web-extension content scripts and
 *   `WKUserScript` injections. Nothing we serve is ever masked; our assets are
 *   same-origin `https://` URLs.
 * - the four extension schemes — the same condition on Chromium, Gecko, and
 *   Safari's newer web-extension packaging, where the URL is not masked but
 *   names the extension bundle outright.
 *
 * Matched as a scheme prefix on the frame's own URL, never as a substring of
 * the message, so a URL of ours that merely mentions one of these words in a
 * query string is not a match.
 */
const FOREIGN_SCRIPT_SCHEMES = [
  'webkit-masked-url:',
  'chrome-extension:',
  'moz-extension:',
  'safari-web-extension:',
  'safari-extension:',
] as const;

interface StackFrameLike {
  filename?: unknown;
  abs_path?: unknown;
}

interface ExceptionLike {
  mechanism?: { handled?: unknown };
  stacktrace?: { frames?: unknown };
}

/**
 * The frame's source URL. posthog-js populates `filename`; `abs_path` is the
 * same value on the parsers that set both, and is read as a fallback so a frame
 * that only carries the absolute path is still attributed.
 */
const frameUrl = (frame: unknown): string | undefined => {
  const { filename, abs_path: absPath } = (frame ?? {}) as StackFrameLike;
  if (typeof filename === 'string' && filename) return filename;
  if (typeof absPath === 'string' && absPath) return absPath;
  return undefined;
};

const isForeignFrame = (frame: unknown): boolean => {
  const url = frameUrl(frame)?.trim().toLowerCase();
  if (!url) return false;
  return FOREIGN_SCRIPT_SCHEMES.some((scheme) => url.startsWith(scheme));
};

/** Every frame foreign, and at least one frame to judge. */
const isEntirelyForeign = (entry: unknown): boolean => {
  const { mechanism, stacktrace } = (entry ?? {}) as ExceptionLike;
  // Only autocaptured throws. A deliberate `captureException` is a report we
  // asked for and is never dropped by an attribution rule.
  if (mechanism?.handled !== false) return false;
  const frames = stacktrace?.frames;
  if (!Array.isArray(frames) || frames.length === 0) return false;
  return frames.every(isForeignFrame);
};

/**
 * Decide whether a captured PostHog event is a throw from an injected foreign
 * script and should be dropped. Returns `true` to DROP.
 *
 * Only `$exception` events are eligible: a `$pageview` or product event that an
 * extension happens to be present for is still true and still worth having.
 */
export function shouldSuppressForeignScriptNoise(
  event: { event?: string; properties?: Record<string, unknown> } | null,
): boolean {
  if (!event || event.event !== '$exception') return false;
  const list = event.properties?.$exception_list;
  if (!Array.isArray(list) || list.length === 0) return false;
  return list.every(isEntirelyForeign);
}
