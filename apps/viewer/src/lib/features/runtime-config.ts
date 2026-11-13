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

import type { FeatureSelection } from './index';

export interface ViewerRuntimeConfig {
  version: 1;
  /** Which features are on. Unknown ids are ignored, so old viewers and new configs mix. */
  features?: FeatureSelection;
  /** BCP 47 tag the host prefers. A language the user chose in Settings still wins. */
  locale?: string;
}

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
export function parseViewerRuntimeConfig(value: unknown): ViewerRuntimeConfig {
  if (!isRecord(value)) invalid('expected a JSON object');
  if (value.version !== 1) invalid(`unsupported version ${JSON.stringify(value.version)}; this viewer reads version 1`);
  const config: ViewerRuntimeConfig = { version: 1 };
  if (value.features !== undefined) config.features = parseFeatures(value.features);
  if (value.locale !== undefined) {
    if (typeof value.locale !== 'string' || value.locale.trim() === '') invalid('locale must be a non-empty string');
    config.locale = value.locale;
  }
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
    return await fetchConfig(target, request.fetch, signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchConfig(target: URL, fetchImpl: typeof fetch, signal: AbortSignal): Promise<ViewerRuntimeConfig> {
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
  return parseViewerRuntimeConfig(body);
}
