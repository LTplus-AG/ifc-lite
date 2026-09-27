/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `http.request` — the one flow node that performs outbound HTTP. It calls
 * the SAME core request function the sandbox's `bim.network.fetch` bridge
 * uses (`@ifc-lite/sandbox`'s `coreNetworkRequest`), so the https-only /
 * exact-host-grant / no-redirect / body-cap / header-denylist policy lives
 * in exactly one implementation.
 *
 * The host allow-list check runs against `ctx.host.networkGrants` — which
 * every caller (CLI, MCP, viewer) populates from the graph's own declared
 * `network.fetch:<host>` capabilities REGARDLESS of whether that caller
 * treats the graph as a "trusted, no capability gate" run (see the doc
 * comment on `FlowHost.networkGrants` in `host.ts`): a local CLI run is
 * trusted to mutate the model it was pointed at, but it is not trusted to
 * reach an arbitrary host the graph never wrote down.
 *
 * `headers`/`body`/`url` are ordinary string/json params, so the graph
 * author can put a `{{secret:NAME}}` reference in a header value; secret
 * interpolation happens one layer up (`@ifc-lite/flow-nodes`'s
 * `secrets.ts`, run by the CLI/MCP entry points before `runFlow` is
 * called) — this node just sees the already-substituted string. It never
 * reads `process.env` itself.
 */

import { coreNetworkRequest, NetworkDeniedError, type NetworkMethod } from '@ifc-lite/sandbox';
import { ANY_ITEM, SCALAR_ITEM, type Ctx, type FlowNodeDef } from './host.js';

interface HttpRequestParams {
  readonly url: string;
  readonly method: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function normalizeMethod(raw: unknown): NetworkMethod {
  const m = typeof raw === 'string' ? raw.toUpperCase() : 'GET';
  if (m === 'GET' || m === 'POST') return m;
  throw new Error(`http.request: unsupported method "${String(raw)}" — only GET and POST are implemented`);
}

function normalizeHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('http.request: "headers" must be an object of string values');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`http.request: header "${k}" must be a string value`);
    out[k] = v;
  }
  return out;
}

/**
 * A numeric bound, or `fallback` when absent or not a number at least `min`.
 * `Number(x) || fallback` read an explicit `maxBytes: 0` as "unset" and
 * lifted the cap to the 5 MiB default.
 */
export function boundOr(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= min ? n : fallback;
}

async function run(ctx: Ctx, _inputs: Readonly<Record<string, unknown>>, params: Readonly<Record<string, unknown>>) {
  const p = params as unknown as HttpRequestParams;
  const url = typeof p.url === 'string' ? p.url : '';
  if (url.length === 0) throw new Error('http.request: "url" is required');
  const grants = ctx.host.networkGrants ?? [];
  try {
    const res = await coreNetworkRequest(
      {
        url,
        method: normalizeMethod(p.method),
        headers: normalizeHeaders(p.headers),
        body: typeof p.body === 'string' ? p.body : undefined,
        timeoutMs: boundOr(p.timeoutMs, DEFAULT_TIMEOUT_MS, 1),
        maxBytes: boundOr(p.maxBytes, DEFAULT_MAX_BYTES, 0),
        signal: ctx.signal,
      },
      grants,
      ctx.host.networkTransport,
    );
    return { status: res.status, headers: res.headers, body: res.body, truncated: res.truncated, ok: res.status >= 200 && res.status < 300 };
  } catch (err) {
    if (err instanceof NetworkDeniedError) throw new Error(`http.request: ${err.message}`);
    throw err;
  }
}

export const httpRequestNode: FlowNodeDef = {
  type: 'http.request',
  title: 'HTTP Request',
  category: 'network',
  doc: 'Issues one https: GET/POST request to a host covered by a granted `network.fetch:<host>` capability. Headers/body may contain `{{secret:NAME}}`, resolved by the CLI/MCP runner before this node sees them — never available in the viewer, where a graph needing a secret shows unavailable before it runs.',
  inputs: [],
  outputs: [
    { name: 'status', type: SCALAR_ITEM },
    { name: 'headers', type: ANY_ITEM },
    { name: 'body', type: SCALAR_ITEM },
    { name: 'truncated', type: SCALAR_ITEM },
    { name: 'ok', type: SCALAR_ITEM },
  ],
  params: [
    { name: 'url', kind: 'string', default: '', doc: 'https:// URL. The hostname must match a granted network.fetch:<host> capability exactly.' },
    { name: 'method', kind: 'enum', default: 'GET', options: ['GET', 'POST'] },
    { name: 'headers', kind: 'json', default: {}, doc: 'Header map. May reference {{secret:NAME}} for a declared secret.' },
    { name: 'body', kind: 'string', default: '', doc: 'Request body for POST. May reference {{secret:NAME}}.' },
    { name: 'timeoutMs', kind: 'number', default: DEFAULT_TIMEOUT_MS },
    { name: 'maxBytes', kind: 'number', default: DEFAULT_MAX_BYTES, doc: 'Response body is capped at this many bytes; the read is aborted mid-stream past it.' },
  ],
  capabilities: ['network.fetch:*'],
  requires: { network: true },
  // A cached answer would skip the request: a POST not sent, a GET stale (#5446 review).
  volatile: true,
  run,
};
