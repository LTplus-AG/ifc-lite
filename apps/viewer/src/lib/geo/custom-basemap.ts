/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Custom basemap imagery for the 3D world context (issue #2685).
 *
 * Scope is deliberately ONE protocol: **XYZ/TMS**, a bare URL template like
 * `https://…/{z}/{x}/{y}.png` served to Cesium's `UrlTemplateImageryProvider`.
 * That is what most public tile services (and the national-aerial reference on
 * the issue) actually publish, and it needs no capabilities negotiation.
 *
 * WMTS is a strictly larger surface — fetch and parse `WMTSCapabilities.xml`,
 * then make the user pick a layer and a tileMatrixSetID — and WMS is not tiled
 * at all. Neither is built here, so the stored shape is a **tagged union keyed
 * on `protocol`**: adding `{ protocol: 'wmts'; capabilitiesUrl; layer;
 * tileMatrixSetID; … }` later is an added member, not a migration of what
 * users already saved. `decodeCustomBasemap` rejects a protocol this build does
 * not implement rather than half-honouring it.
 *
 * Everything here is pure and Cesium-free (the provider options are a plain
 * object), so it is unit-testable without a WebGL context.
 */

/** Protocols this build can render. WMTS/WMS are deliberately absent. */
export type CustomBasemapProtocol = 'xyz';

export interface CustomBasemap {
  protocol: 'xyz';
  /** URL template containing `{z}`, `{x}` and `{y}` (or `{reverseY}`). */
  url: string;
  /** Visible attribution text. Required — see `validateCustomBasemap`. */
  credit: string;
  /** Optional http(s) link the attribution points at (licence page). */
  creditUrl?: string;
  /** Deepest zoom the server serves; requests past it 404. */
  maximumLevel?: number;
}

export interface CustomBasemapDraft {
  protocol?: string;
  url?: string;
  credit?: string;
  creditUrl?: string;
  maximumLevel?: number;
}

export type CustomBasemapField = 'protocol' | 'url' | 'credit' | 'creditUrl' | 'maximumLevel';

export type ValidationResult =
  | { ok: true; basemap: CustomBasemap }
  | { ok: false; field: CustomBasemapField; message: string };

/**
 * Placeholders `UrlTemplateImageryProvider` substitutes for a tile request.
 * Anything else in braces is a typo or a service-specific token (an API key
 * slot, a WMTS `{TileMatrix}`) that Cesium would send verbatim, producing a
 * 404 on every tile — so it is rejected at input time with the token named,
 * instead of showing up later as a blank globe.
 *
 * **`{s}` is deliberately absent.** Cesium does substitute it, but from a
 * `subdomains` option this editor has no field for, so it would default to
 * `["a","b","c"]` — and a server sharding over `1,2,3,4` would then validate,
 * save, probe a hostname that may not exist, and 404 every tile at render with
 * no banner (a 404 carries a `statusCode`, so the runtime classifier correctly
 * stays quiet). That is precisely the silent blank globe this allowlist exists
 * to prevent, and subdomain sharding is a load-balancing hint rather than a
 * correctness requirement — the bare host almost always serves the same
 * pyramid. Rejecting it at input time names the problem while the user is
 * looking at the field. Adding `subdomains` later re-admits the token as a new
 * capability, the same way `protocol` admits WMTS: an addition, not a fix.
 */
const SUPPORTED_PLACEHOLDERS = new Set(['z', 'x', 'y', 'reverseX', 'reverseY', 'reverseZ']);

const PLACEHOLDER_RE = /\{([^}]*)\}/g;

const MAX_TILE_LEVEL = 30;

function fail(field: CustomBasemapField, message: string): ValidationResult {
  return { ok: false, field, message };
}

/**
 * Validate a user-entered basemap. Every rejection carries the field it came
 * from so the input surface can point at it.
 */
export function validateCustomBasemap(draft: CustomBasemapDraft): ValidationResult {
  if (draft.protocol !== undefined && draft.protocol !== 'xyz') {
    return fail('protocol', `Unsupported basemap protocol "${draft.protocol}". This build serves XYZ/TMS tile templates only.`);
  }

  const url = (draft.url ?? '').trim();
  if (!url) return fail('url', 'Enter a tile URL template, e.g. https://example.org/tiles/{z}/{x}/{y}.png');

  // Parse with the placeholders replaced: `{z}` is legal in a template but not
  // in a URL, and `new URL` would reject or mangle it.
  let parsed: URL;
  try {
    parsed = new URL(url.replace(PLACEHOLDER_RE, '0'));
  } catch {
    return fail('url', 'That is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return fail('url', 'Tiles are fetched by the browser, so the URL must be http or https.');
  }
  if (parsed.username || parsed.password) {
    // Never echo the value back: the message is rendered in the UI.
    return fail('url', 'Remove the username and password from the URL: they would be stored in this browser in cleartext and sent with every tile request.');
  }

  const seen = new Set<string>();
  for (const match of url.matchAll(PLACEHOLDER_RE)) {
    const token = match[1];
    if (!SUPPORTED_PLACEHOLDERS.has(token)) {
      const hint = token === 's'
        ? ' This viewer has no subdomain field, so {s} would be filled from Cesium\'s a/b/c default and 404 on a server that shards differently: use the bare hostname instead.'
        : '';
      return fail('url', `"{${token}}" is not a tile placeholder this viewer substitutes. Supported: {z}, {x}, {y}, {reverseX}, {reverseY}, {reverseZ}.${hint}`);
    }
    seen.add(token);
  }
  const missing: string[] = [];
  if (!seen.has('z') && !seen.has('reverseZ')) missing.push('{z}');
  if (!seen.has('x') && !seen.has('reverseX')) missing.push('{x}');
  if (!seen.has('y') && !seen.has('reverseY')) missing.push('{y}');
  if (missing.length > 0) {
    return fail('url', `An XYZ template needs ${missing.join(', ')}: without it every request is the same tile.`);
  }

  const credit = (draft.credit ?? '').trim();
  if (!credit) {
    // Required, not optional: an XYZ template carries no capabilities document,
    // so there is nowhere but this field for the attribution to come from, and
    // most public imagery is licensed on condition of visible credit.
    return fail('credit', 'Attribution is required. Most public imagery is licensed on condition of visible credit, and an XYZ URL carries none: copy the wording the provider asks for.');
  }

  const creditUrl = (draft.creditUrl ?? '').trim();
  if (creditUrl) {
    let parsedCredit: URL;
    try {
      parsedCredit = new URL(creditUrl);
    } catch {
      return fail('creditUrl', 'The attribution link is not a valid URL.');
    }
    if (parsedCredit.protocol !== 'https:' && parsedCredit.protocol !== 'http:') {
      return fail('creditUrl', 'The attribution link must be http or https.');
    }
  }

  const maximumLevel = draft.maximumLevel;
  if (maximumLevel !== undefined) {
    if (!Number.isInteger(maximumLevel) || maximumLevel < 1 || maximumLevel > MAX_TILE_LEVEL) {
      return fail('maximumLevel', `Maximum zoom must be a whole number between 1 and ${MAX_TILE_LEVEL}.`);
    }
  }
  if (seen.has('reverseZ') && maximumLevel === undefined) {
    // Cesium's UrlTemplateImageryProvider only flips {reverseZ} when
    // `maximumLevel` is defined (`defined(maximumLevel) && level < maximumLevel
    // ? maximumLevel - level - 1 : level`). Without it, {reverseZ} silently
    // resolves to the ordinary `level` — no error, no blank globe, just the
    // wrong tile at every zoom for a genuinely reverse-Z service. That failure
    // has no visible signal, unlike the CORS/blocked-host case this feature
    // otherwise makes loud, so it is rejected here instead.
    return fail('maximumLevel', 'A "{reverseZ}" template needs a maximum zoom level: without it Cesium cannot invert the level and silently falls back to the ordinary {z} numbering.');
  }

  return {
    ok: true,
    basemap: {
      protocol: 'xyz',
      url,
      credit,
      ...(creditUrl ? { creditUrl } : {}),
      ...(maximumLevel !== undefined ? { maximumLevel } : {}),
    },
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Build the attribution markup Cesium renders on-canvas.
 *
 * Cesium's `Credit` takes HTML and does sanitize it (`Credit.js` runs
 * DOMPurify), but we never hand it user markup in the first place: the credit
 * is escaped **text**, and the only tag is an anchor we construct ourselves
 * around an already-validated http(s) href. That keeps the licence link the
 * providers require without making the field a markup channel.
 */
export function buildCreditHtml(basemap: Pick<CustomBasemap, 'credit' | 'creditUrl'>): string {
  const text = escapeHtml(basemap.credit);
  if (!basemap.creditUrl) return text;
  return `<a href="${escapeHtml(basemap.creditUrl)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

export interface UrlTemplateProviderOptions {
  url: string;
  credit: string;
  maximumLevel?: number;
}

/** The options object for `new Cesium.UrlTemplateImageryProvider(...)`. */
export function toUrlTemplateProviderOptions(basemap: CustomBasemap): UrlTemplateProviderOptions {
  return {
    url: basemap.url,
    credit: buildCreditHtml(basemap),
    // Cesium treats a present-but-undefined `maximumLevel` as "no limit"
    // either way, but omitting it keeps the object honest for assertions.
    ...(basemap.maximumLevel !== undefined ? { maximumLevel: basemap.maximumLevel } : {}),
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

export function encodeCustomBasemap(basemap: CustomBasemap): string {
  return JSON.stringify(basemap);
}

/** Sentinel for "present but the wrong type" — distinct from a missing field. */
const INVALID: unique symbol = Symbol('invalid');

/** `undefined` passes through; anything present that is not a string fails. */
function optionalString(value: unknown): string | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : INVALID;
}

/**
 * Read a stored basemap back. Re-validates rather than trusting the string:
 * localStorage is hand-editable and shared with every other tab on the origin,
 * so a stored `creditUrl: "javascript:…"` must not become an on-canvas anchor.
 * An unrecognised `protocol` (a WMTS entry written by a later build) returns
 * null instead of being rendered as if it were XYZ.
 *
 * **Types are checked here, not defaulted.** `CustomBasemapDraft` is a
 * compile-time shape; `JSON.parse` output honours none of it, and
 * `validateCustomBasemap` reaches for `.trim()` on the string fields. A
 * hand-edited `"url": 123` would therefore throw a `TypeError` — out of
 * `loadCustomBasemap`, out of `createCesiumSlice`, and out of the module-scope
 * store creation, i.e. a white screen with no in-app way to clear the key. So
 * every field is type-checked before the draft is built, and the whole body is
 * wrapped: this function's contract is "returns null on anything it dislikes",
 * and a decoder for hostile input owes the caller that unconditionally.
 */
export function decodeCustomBasemap(raw: string | null): CustomBasemap | null {
  if (!raw) return null;
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;

    const protocol = optionalString(record.protocol);
    const url = optionalString(record.url);
    const credit = optionalString(record.credit);
    const creditUrl = optionalString(record.creditUrl);
    if (protocol === INVALID || url === INVALID || credit === INVALID || creditUrl === INVALID) {
      return null;
    }
    // `validateCustomBasemap` already rejects a non-integer maximumLevel, but
    // check the type here too so the reason is "wrong type", not "out of range".
    const maximumLevel = record.maximumLevel;
    if (maximumLevel !== undefined && typeof maximumLevel !== 'number') return null;

    const result = validateCustomBasemap({ protocol, url, credit, creditUrl, maximumLevel });
    return result.ok ? result.basemap : null;
  } catch {
    return null;
  }
}

// ─── Browser access (CORS) ──────────────────────────────────────────────────

export interface TileAccessResult {
  /** Whether a browser may read this server's tiles at all (the CORS verdict). */
  status: 'ok' | 'blocked';
  message?: string;
  httpStatus?: number;
  /**
   * True when the message reports a problem the user should act on, even
   * though CORS itself is fine — a 401/403 says the key is missing or wrong.
   * Kept separate from `status` because the two verdicts are independent.
   */
  concerning?: boolean;
}

export const BROWSER_ACCESS_BLOCKED =
  'This server does not allow browser access (no CORS headers), or it could not be reached. Tiles would render blank rather than fail visibly.';

/**
 * Substitute a concrete z0 tile so the template can be fetched once. Every
 * placeholder that survives validation is numeric (`{s}` is rejected), so a
 * flat `0` is a well-formed tile address for all of them.
 */
export function firstTileUrl(basemap: CustomBasemap): string {
  return basemap.url.replace(PLACEHOLDER_RE, '0');
}

/**
 * Ask the tile server for one tile and report whether a browser may read it.
 *
 * The discrimination is not the status code: a cross-origin response that
 * reaches JavaScript **at all** has already passed the CORS check, so any
 * readable response — including a 404 from a server whose pyramid starts below
 * z0 — proves browser access works. Only a rejected `fetch` (the opaque
 * `TypeError` the platform gives for a blocked or unreachable request) means
 * the layer would silently render nothing. `mode: 'cors'` is load-bearing:
 * a `no-cors` request resolves opaquely and would report success for exactly
 * the server this check exists to catch.
 */
/**
 * How long the probe waits for the zero tile before giving up.
 *
 * A `fetch` that is refused rejects promptly; a host that completes the
 * handshake and then never answers does not reject at all, and the probe runs
 * on the user's Save path — so without a bound, Save spins with no verdict and
 * no way to tell a slow check from a hung one. Ten seconds is well past any
 * tile server worth configuring and well short of the point where a user
 * concludes the button is broken.
 *
 * Overridable per call so the tests can exercise the bound without waiting on
 * it; the shipped default is what production uses.
 */
export const TILE_PROBE_TIMEOUT_MS = 10_000;

/**
 * Distinct from {@link BROWSER_ACCESS_BLOCKED} because it is a different claim.
 * "This server does not allow browser access" is specific and actionable, and
 * it would be the wrong thing to tell someone whose host is merely slow — the
 * tiles may serve perfectly once the globe is up, and the user would be sent to
 * fix a CORS configuration that is fine.
 */
function tileProbeTimedOutMessage(timeoutMs: number): string {
  // Derived from the bound actually applied, not written out beside it: a
  // message naming a duration the code no longer uses is worse than none.
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  return `The server did not respond within ${seconds} second${seconds === 1 ? '' : 's'}, so browser access could not be verified. It may still work: check the imagery once the globe is up.`;
}

export async function probeTileAccess(
  basemap: CustomBasemap,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = TILE_PROBE_TIMEOUT_MS,
): Promise<TileAccessResult> {
  const url = firstTileUrl(basemap);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.ok) return { status: 'ok', httpStatus: response.status };
    // "Normal for a deeper-starting pyramid" is true of a 404 and false of an
    // auth refusal: a 401/403 means every tile at every zoom will be refused,
    // so reassuring wording there would be actively wrong. CORS is fine either
    // way — the response reached JavaScript — which is why `status` stays 'ok'.
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'ok',
        httpStatus: response.status,
        concerning: true,
        message: `The server allows browser access but refused the tile with ${response.status}. That is an authorisation failure, not a missing tile, so every zoom level will be refused the same way: check whether this service needs an API key in the URL, and whether the key it carries is still valid.`,
      };
    }
    return {
      status: 'ok',
      httpStatus: response.status,
      message: `The server allows browser access but answered ${response.status} for the zoom-0 tile. That is normal for a service whose tiles start at a deeper zoom; check the imagery once the globe is over your site.`,
    };
  } catch {
    // Our own abort is the one rejection that is NOT evidence about CORS: the
    // request never got an answer either way. Everything else reaching here is
    // the opaque `TypeError` the platform gives for a blocked or unreachable
    // request, which is exactly the finding.
    if (controller.signal.aborted) {
      return { status: 'blocked', message: tileProbeTimedOutMessage(timeoutMs) };
    }
    return { status: 'blocked', message: BROWSER_ACCESS_BLOCKED };
  } finally {
    clearTimeout(timer);
  }
}

/** The slice of a Cesium imagery provider this module needs to wrap. */
export interface RequestImageProvider {
  requestImage: (...args: never[]) => unknown;
}

/**
 * Make the browser-access banner retractable.
 *
 * `classifyTileProviderError` raises the banner from a **single** failed tile,
 * which one ad-blocker rule or one DNS blip is enough to produce. Without a way
 * back down, that transient failure leaves "this server does not allow browser
 * access" sitting permanently over a basemap that is drawing fine.
 *
 * Cesium signals recovery internally (`TileProviderError.reportSuccess`) but
 * exposes no success event, so the evidence is taken from the request itself: a
 * `requestImage` promise that RESOLVES means a cross-origin tile was read by
 * this browser — which is precisely the claim the banner denies, and therefore
 * precisely what retracts it. Nothing else is retracted: a successful tile
 * disproves "no browser access" and says nothing about any other warning.
 *
 * `requestImage` returns `undefined` when Cesium throttles the request; that is
 * not a failure and not a success, so it is passed through untouched.
 */
export function attachTileSuccessRetraction(
  provider: RequestImageProvider,
  setWarning: (update: (current: string | null) => string | null) => void,
): void {
  const original = provider.requestImage.bind(provider) as (...args: unknown[]) => unknown;
  provider.requestImage = ((...args: unknown[]) => {
    const pending = original(...args);
    if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
      Promise.resolve(pending).then(
        () => setWarning((current) => (current === BROWSER_ACCESS_BLOCKED ? null : current)),
        () => { /* failures belong to the errorEvent listener, not here */ },
      );
    }
    return pending;
  }) as RequestImageProvider['requestImage'];
}

/**
 * Classify a Cesium `TileProviderError` raised on `imageryProvider.errorEvent`.
 *
 * Cesium rejects a failed tile request with a `RequestErrorEvent`
 * (`{ statusCode, response, responseHeaders }`). A CORS refusal never produces
 * a response, so `statusCode` is undefined — that absence is what separates
 * "the browser was refused" from "that particular tile is missing", which is a
 * normal and uninteresting event at the edge of a pyramid. Returns null when
 * there is nothing worth telling the user, so the caller never guesses.
 */
export function classifyTileProviderError(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return null;
  const inner = (event as { error?: unknown }).error;
  if (typeof inner !== 'object' || inner === null) return null;
  if (inner instanceof Error) return null;
  if (!('statusCode' in inner)) return null;
  const statusCode = (inner as { statusCode?: unknown }).statusCode;
  if (statusCode === undefined) return BROWSER_ACCESS_BLOCKED;
  return null;
}
