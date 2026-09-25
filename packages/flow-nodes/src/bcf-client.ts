/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The shared plumbing of the `bcf.*` flow nodes (#5167 phase 3.4): the
 * connection params every one of them takes, and a `BcfApiClient` whose
 * `fetchFn` is the gated `coreNetworkRequest` from `@ifc-lite/sandbox` —
 * the same function `http.request` and `bim.network.fetch` use. So every
 * request the BCF client issues passes the https-only / exact-host-grant /
 * no-redirect / body-cap policy against `ctx.host.networkGrants`, and moves
 * over `ctx.host.networkTransport`; a BCF node never reaches bare `fetch`.
 *
 * The bearer token is an ordinary string param, so a graph writes
 * `{{secret:BCF_TOKEN}}` and the CLI/MCP runner substitutes it before the
 * node runs (see `secrets.ts`). It is handed to the client's
 * `getAccessToken` and appears nowhere else: never logged, never in an
 * output, never in an error message this module composes.
 */

import { BcfApiClient, type FetchLike } from '@ifc-lite/bcf-api';
import type { ParamDef } from '@ifc-lite/flow';
import { coreNetworkRequest, NetworkDeniedError } from '@ifc-lite/sandbox';
import type { Ctx } from './host.js';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Connection params shared by every `bcf.*` node, in palette order. */
export const BCF_CONNECTION_PARAMS: readonly ParamDef[] = [
  { name: 'baseUrl', kind: 'string', default: '', doc: 'https:// BCF API base URL, up to but excluding the version segment (e.g. https://bcf.example.com/bcf). The hostname must match a granted network.fetch:<host> capability exactly.' },
  { name: 'version', kind: 'string', default: '2.1', doc: 'BCF API version segment.' },
  { name: 'projectId', kind: 'string', default: '', doc: 'BCF project id.' },
  { name: 'token', kind: 'string', default: '', doc: 'Bearer access token, sent as `Authorization: Bearer <token>`. Use {{secret:NAME}} with a declared secret.read:NAME; leave empty for an anonymous server.' },
  { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS, doc: 'Wall-clock limit per request.' },
  { name: 'maxBytes', kind: 'number', default: DEFAULT_MAX_BYTES, doc: 'Response body cap per request; a larger response fails the node rather than being parsed truncated.' },
];

/** A numeric bound, or `fallback` when absent or below `min` (same reading as `http.request`). */
function boundOr(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/** Statuses whose `Response` must have a null body (the constructor throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * A `FetchLike` for `BcfApiClient` that sends every request through
 * `coreNetworkRequest`. Only GET and POST exist there, and they are all the
 * `bcf.*` nodes need; any other method is refused before the network.
 */
export function gatedBcfFetch(ctx: Ctx, nodeType: string, params: Readonly<Record<string, unknown>>): FetchLike {
  const timeoutMs = boundOr(params.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
  const maxBytes = boundOr(params.maxBytes, DEFAULT_MAX_BYTES, 0);
  return async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new Error(`${nodeType}: HTTP method ${method} is not supported`);
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== 'string') {
      throw new Error(`${nodeType}: only JSON request bodies are supported`);
    }
    const res = await coreNetworkRequest(
      { url, method, headers: headerRecord(init?.headers), body: body ?? undefined, timeoutMs, maxBytes, signal: ctx.signal },
      ctx.host.networkGrants ?? [],
      ctx.host.networkTransport,
    );
    // A cut-off JSON body would surface as a confusing parse error; name the cap instead.
    if (res.truncated) throw new Error(`${nodeType}: response from ${url} exceeded maxBytes (${maxBytes}); raise the node's maxBytes param`);
    return new Response(NULL_BODY_STATUSES.has(res.status) ? null : res.body, { status: res.status, headers: res.headers });
  };
}

/** Required non-empty string param, trimmed. */
export function requiredString(nodeType: string, params: Readonly<Record<string, unknown>>, name: string): string {
  const v = params[name];
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length === 0) throw new Error(`${nodeType}: "${name}" is required`);
  return s;
}

/** A `BcfApiClient` over the gated transport, plus the project it addresses. */
export function bcfClientFor(
  ctx: Ctx,
  nodeType: string,
  params: Readonly<Record<string, unknown>>,
): { client: BcfApiClient; projectId: string } {
  const baseUrl = requiredString(nodeType, params, 'baseUrl');
  try {
    new URL(baseUrl);
  } catch {
    throw new Error(`${nodeType}: "baseUrl" is not a valid URL`);
  }
  const projectId = requiredString(nodeType, params, 'projectId');
  const version = typeof params.version === 'string' && params.version.trim() !== '' ? params.version.trim() : '2.1';
  const token = typeof params.token === 'string' ? params.token.trim() : '';
  const client = new BcfApiClient({
    baseUrl,
    version,
    getAccessToken: () => (token.length > 0 ? token : undefined),
    fetchFn: gatedBcfFetch(ctx, nodeType, params),
  });
  return { client, projectId };
}

/** Name the node on a denial, as `http.request` does; every other error passes through unchanged. */
export async function withBcfErrors<T>(nodeType: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof NetworkDeniedError) throw new Error(`${nodeType}: ${err.message}`, { cause: err });
    throw err;
  }
}
