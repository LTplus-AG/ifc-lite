/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The configuration a host hands the stock viewer at start, and the one fetch
 * that gets it when the build names a URL (`VITE_VIEWER_CONFIG_URL`).
 *
 * Loading FAILS CLOSED. A host that restricts features must never end up
 * with a viewer that shows everything because its config endpoint was down,
 * so every failure here (wrong origin, network, status, body, shape) throws a
 * `ViewerConfigError` and the entry shows an error instead of mounting.
 */

import { normalizeProcessedModelHash } from '@ifc-lite/server-client/processed-model';
import { isLoopbackHostname } from '../loopback.js';
import { yawTransform } from '../model-placement/matrix-placement.js';
import type { FeatureSelection } from './index';

export interface ViewerRuntimeConfig {
  version: 1;
  /** Which features are on. Unknown ids are ignored, so old viewers and new configs mix. */
  features?: FeatureSelection;
  /** BCP 47 tag the host prefers. A language the user chose in Settings still wins. */
  locale?: string;
  /** The processing server for server-processed models: a path on this origin or an http(s) URL. Replaces `VITE_IFC_SERVER_URL`. */
  server?: { url: string };
  /**
   * What to open at start, without the IFC reaching the browser. `federation`, when present,
   * wins: `processedModel` is then only for viewers that predate federations.
   */
  open?: { processedModel?: ProcessedModelStart; federation?: ProcessedFederationStart };
}

/** A model the processing server already processed. */
export interface ProcessedModelStart { sha256: string; bytes: number; name: string }

/** One model of a federation: a stored result, its place in the federation, and whether it starts visible. */
export interface ProcessedFederationSlot extends ProcessedModelStart {
  /** The host's stable id for this slot; the loaded model keeps it as its id. */
  slot: string;
  /** What the model list shows; at most 120 characters. */
  label: string;
  visible: boolean;
  /**
   * Column-major 4x4 in the slot model's own IFC world frame: project coordinates in metres, Z up.
   * A heading about the vertical axis through that frame's origin, then a translation; nothing else.
   * Independent of the viewer's render origin (RTC shift), which the viewer accounts for itself.
   */
  transform?: number[];
}

/** Several processed models opened together; the first slot is the primary model. */
export interface ProcessedFederationStart {
  id: string;
  slots: ProcessedFederationSlot[];
}

/** The most slots one federation may name. */
export const MAX_FEDERATION_SLOTS = 64;
/** The longest federation or slot id; ids are identities, not text. */
const MAX_ID_LENGTH = 128;
/** The longest slot label: a model-list row, not a document. */
const MAX_LABEL_LENGTH = 120;

/** Why a configuration could not be used. `code` is stable; `message` is for the console. */
export type ViewerConfigErrorCode = 'cross-origin' | 'unreachable' | 'status' | 'not-json' | 'invalid';

export class ViewerConfigError extends Error {
  readonly code: ViewerConfigErrorCode;
  constructor(code: ViewerConfigErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ViewerConfigError';
    this.code = code;
  }
}

/** The query parameter a host puts on the viewer URL to say what the page is for. */
export const CONTEXT_QUERY_PARAM = 'context';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(what: string): never {
  throw new ViewerConfigError('invalid', `Viewer configuration is invalid: ${what}`);
}

function stringList(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) invalid(`${where} must be a list of strings`);
  return value as string[];
}

const SAME_ORIGIN = 'https://viewer.invalid';
// The member's name only, to keep the eager bundle small; the rules are in docs/guide/viewer-deployment-config.md.
const BAD_SERVER = 'server.url';
const BAD_OPEN = 'open.processedModel';
const BAD_FEDERATION = 'open.federation';

/**
 * A same-origin path (`/…`, not `//…`) or an absolute `https:` URL; `http:` only
 * from an `http:` page or to a loopback host. Kept in normalized form. No
 * query, fragment or credentials: the client appends `/api/v1/…` to it.
 */
function parseServer(value: unknown, pageUrl: string | undefined): { url: string } {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url.trim() === '') invalid(BAD_SERVER);
  const raw = value.url.trim();
  const isPath = raw.startsWith('/') && !raw.startsWith('//');
  let url: URL;
  try {
    url = new URL(raw, isPath ? SAME_ORIGIN : undefined);
  } catch {
    invalid(BAD_SERVER);
  }
  // A literal ? or # always opens a query or fragment, even an empty one that `search`/`hash` report as ''.
  if (/[?#]/.test(raw) || url.username || url.password) invalid(BAD_SERVER);
  if (isPath) {
    // `/\host` parses as another host, and dot segments can normalize to `//host`.
    if (url.origin !== SAME_ORIGIN || url.pathname.startsWith('//')) invalid(BAD_SERVER);
    return { url: url.pathname };
  }
  const httpPage = pageUrl !== undefined && new URL(pageUrl).protocol === 'http:';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (httpPage || isLoopbackHostname(url.hostname)))) {
    invalid(BAD_SERVER);
  }
  return { url: url.href };
}

/** A stored result, its hash lowercased by the server client's rule. */
function parseProcessedModel(value: unknown, where: string): ProcessedModelStart {
  if (!isRecord(value)) invalid(where);
  const { sha256, bytes, name } = value;
  const hash = normalizeProcessedModelHash(sha256) ?? invalid(where);
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) invalid(where);
  if (typeof name !== 'string' || name.trim() === '') invalid(where);
  return { sha256: hash, bytes, name };
}

function isId(value: unknown): value is string {
  // No control characters: an id lands in logs and in model maps, never as markup.
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ID_LENGTH) return false;
  for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code < 32 || code === 127) return false; }
  return true;
}

function parseFederation(value: unknown): ProcessedFederationStart {
  if (!isRecord(value) || !isId(value.id) || !Array.isArray(value.slots)) invalid(BAD_FEDERATION);
  if (value.slots.length === 0 || value.slots.length > MAX_FEDERATION_SLOTS) invalid(`${BAD_FEDERATION}.slots`);
  const seen = new Set<string>();
  const slots = value.slots.map((entry: unknown, index): ProcessedFederationSlot => {
    const where = `${BAD_FEDERATION}.slots[${index}]`;
    if (!isRecord(entry) || !isId(entry.slot) || seen.has(entry.slot)) invalid(where);
    if (typeof entry.label !== 'string' || entry.label.trim() === '' || entry.label.length > MAX_LABEL_LENGTH || typeof entry.visible !== 'boolean') invalid(where);
    seen.add(entry.slot);
    const slot: ProcessedFederationSlot = { slot: entry.slot, label: entry.label, ...parseProcessedModel(entry, where), visible: entry.visible };
    if (entry.transform !== undefined) {
      if (!yawTransform(entry.transform)) invalid(`${where}.transform`);
      slot.transform = [...(entry.transform as number[])];
    }
    return slot;
  });
  return { id: value.id, slots };
}

/** The start model or federation. A present member is checked even when another wins: a malformed one is a host bug either way. */
function parseOpen(value: unknown): NonNullable<ViewerRuntimeConfig['open']> {
  if (!isRecord(value) || (value.processedModel === undefined && value.federation === undefined)) invalid(BAD_OPEN);
  const processedModel = value.processedModel === undefined ? undefined : parseProcessedModel(value.processedModel, BAD_OPEN);
  if (value.federation !== undefined) return { federation: parseFederation(value.federation) };
  return { processedModel: processedModel ?? invalid(BAD_OPEN) };
}

function parseFeatures(value: unknown): FeatureSelection {
  if (!isRecord(value)) invalid('features must be an object');
  if (value.default !== 'all' && value.default !== 'none') invalid("features.default must be 'all' or 'none'");
  return {
    default: value.default,
    enable: stringList(value.enable, 'features.enable'),
    disable: stringList(value.disable, 'features.disable'),
  };
}

/**
 * Check an untrusted value against the version 1 shape. Members this viewer
 * does not know are dropped, not refused: a newer host may send more.
 */
export function parseViewerRuntimeConfig(
  value: unknown,
  /** The page the viewer runs on; decides whether an `http:` server URL is allowed. */
  pageUrl: string | undefined = typeof location === 'undefined' ? undefined : location.href,
): ViewerRuntimeConfig {
  if (!isRecord(value)) invalid('expected a JSON object');
  if (value.version !== 1) invalid(`unsupported version ${JSON.stringify(value.version)}; this viewer reads version 1`);
  const config: ViewerRuntimeConfig = { version: 1 };
  if (value.features !== undefined) config.features = parseFeatures(value.features);
  if (value.locale !== undefined) {
    if (typeof value.locale !== 'string' || value.locale.trim() === '') invalid('locale must be a non-empty string');
    config.locale = value.locale;
  }
  if (value.server !== undefined) config.server = parseServer(value.server, pageUrl);
  if (value.open !== undefined) config.open = parseOpen(value.open);
  return config;
}

export interface ViewerConfigRequest {
  /** `VITE_VIEWER_CONFIG_URL`: a path or URL on the page's own origin. */
  url: string;
  /** The page's `location.href`: the base for a relative `url` and the source of `?context=`. */
  pageUrl: string;
  fetch: typeof fetch;
  /** How long the whole request may take, body included, before it counts as unreachable. */
  timeoutMs?: number;
}

/**
 * A request that never answers must end in the error screen, and before the
 * boot watchdog's 30 s backstop in `index.html`: `#root` is empty while the
 * configuration loads, so a later end would let the watchdog reload a page
 * whose only problem is a slow endpoint.
 */
const CONFIG_TIMEOUT_MS = 15_000;

/**
 * Fetch and check the host's configuration. Same-origin only, like the
 * `?model=` autoload: the request carries the user's cookies, and the answer
 * decides what the viewer shows, so neither may involve another origin.
 */
export async function loadViewerRuntimeConfig(request: ViewerConfigRequest): Promise<ViewerRuntimeConfig> {
  const page = new URL(request.pageUrl);
  let target: URL;
  try {
    target = new URL(request.url, page);
  } catch (error) {
    throw new ViewerConfigError('invalid', 'The viewer configuration URL is malformed', { cause: error });
  }
  if (target.origin !== page.origin) {
    throw new ViewerConfigError('cross-origin', `The viewer configuration must come from ${page.origin}, not ${target.origin}`);
  }
  const context = page.searchParams.get(CONTEXT_QUERY_PARAM);
  if (context !== null) target.searchParams.set(CONTEXT_QUERY_PARAM, context);

  // A plain timer, not `AbortSignal.timeout`: that one's timer does not keep a
  // Node process alive, so a test of the timeout would end before it fires.
  const timeout = new AbortController();
  const signal = timeout.signal;
  const timer = setTimeout(() => timeout.abort(new DOMException('The viewer configuration timed out', 'TimeoutError')), request.timeoutMs ?? CONFIG_TIMEOUT_MS);
  try {
    return await fetchConfig(target, page, request.fetch, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchConfig(target: URL, page: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ViewerRuntimeConfig> {
  let response: Response;
  try {
    response = await fetchImpl(target.href, {
      // The platform refuses a redirect to another origin before requesting it.
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new ViewerConfigError('unreachable', 'The viewer configuration could not be fetched (network failure, or a redirect to another origin)', { cause: error });
  }
  // A caller's own fetch (a wrapper, a polyfill) may ignore `mode`; the answer must still be ours.
  if (response.url && new URL(response.url, page).origin !== page.origin) {
    throw new ViewerConfigError('cross-origin', `The viewer configuration was redirected away from ${page.origin}`);
  }
  if (!response.ok) {
    throw new ViewerConfigError('status', `The viewer configuration request answered ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    // The timeout also covers the body; a body that stops arriving is unreachable, not malformed.
    if (signal.aborted) throw new ViewerConfigError('unreachable', 'The viewer configuration did not arrive in time', { cause: error });
    throw new ViewerConfigError('not-json', 'The viewer configuration is not JSON', { cause: error });
  }
  return parseViewerRuntimeConfig(body, page.href);
}
