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
 */
const SUPPORTED_PLACEHOLDERS = new Set(['z', 'x', 'y', 'reverseX', 'reverseY', 'reverseZ', 's']);

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
    return fail('url', 'Remove the username and password from the URL — they would be stored in this browser in cleartext and sent with every tile request.');
  }

  const seen = new Set<string>();
  for (const match of url.matchAll(PLACEHOLDER_RE)) {
    const token = match[1];
    if (!SUPPORTED_PLACEHOLDERS.has(token)) {
      return fail('url', `"{${token}}" is not a tile placeholder this viewer substitutes. Supported: {z}, {x}, {y}, {reverseX}, {reverseY}, {reverseZ}, {s}.`);
    }
    seen.add(token);
  }
  const missing: string[] = [];
  if (!seen.has('z') && !seen.has('reverseZ')) missing.push('{z}');
  if (!seen.has('x') && !seen.has('reverseX')) missing.push('{x}');
  if (!seen.has('y') && !seen.has('reverseY')) missing.push('{y}');
  if (missing.length > 0) {
    return fail('url', `An XYZ template needs ${missing.join(', ')} — without it every request is the same tile.`);
  }

  const credit = (draft.credit ?? '').trim();
  if (!credit) {
    // Required, not optional: an XYZ template carries no capabilities document,
    // so there is nowhere but this field for the attribution to come from, and
    // most public imagery is licensed on condition of visible credit.
    return fail('credit', 'Attribution is required. Most public imagery is licensed on condition of visible credit, and an XYZ URL carries none — copy the wording the provider asks for.');
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

/**
 * Read a stored basemap back. Re-validates rather than trusting the string:
 * localStorage is hand-editable and shared with every other tab on the origin,
 * so a stored `creditUrl: "javascript:…"` must not become an on-canvas anchor.
 * An unrecognised `protocol` (a WMTS entry written by a later build) returns
 * null instead of being rendered as if it were XYZ.
 */
export function decodeCustomBasemap(raw: string | null): CustomBasemap | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const draft = parsed as CustomBasemapDraft;
  const result = validateCustomBasemap({
    protocol: draft.protocol,
    url: draft.url,
    credit: draft.credit,
    creditUrl: draft.creditUrl,
    maximumLevel: draft.maximumLevel,
  });
  return result.ok ? result.basemap : null;
}

// ─── Browser access (CORS) ──────────────────────────────────────────────────

export interface TileAccessResult {
  status: 'ok' | 'blocked';
  message?: string;
  httpStatus?: number;
}

export const BROWSER_ACCESS_BLOCKED =
  'This server does not allow browser access (no CORS headers), or it could not be reached. Tiles would render blank rather than fail visibly.';

/** Substitute a concrete z0 tile so the template can be fetched once. */
export function firstTileUrl(basemap: CustomBasemap): string {
  return basemap.url.replace(PLACEHOLDER_RE, (_match, token: string) => (token === 's' ? 'a' : '0'));
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
export async function probeTileAccess(
  basemap: CustomBasemap,
  fetchImpl: typeof fetch = fetch,
): Promise<TileAccessResult> {
  const url = firstTileUrl(basemap);
  try {
    const response = await fetchImpl(url, { method: 'GET', mode: 'cors', cache: 'no-store' });
    if (response.ok) return { status: 'ok', httpStatus: response.status };
    return {
      status: 'ok',
      httpStatus: response.status,
      message: `The server allows browser access but answered ${response.status} for the zoom-0 tile. That is normal for a service whose tiles start at a deeper zoom; check the imagery once the globe is over your site.`,
    };
  } catch {
    return { status: 'blocked', message: BROWSER_ACCESS_BLOCKED };
  }
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
