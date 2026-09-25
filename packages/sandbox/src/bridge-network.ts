/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bridge schema — bim.network namespace: `bim.network.fetch` inside a
 * Script node.
 *
 * Gated by the `network` permission (off by default, `DEFAULT_PERMISSIONS`
 * — see types.ts), which only decides whether `bim.network` exists on the
 * realm at all. The permission flag is a coarse "this graph has at least
 * one network.fetch grant" signal, derived by the caller (`script-node.ts`,
 * mirroring how it derives `mutate`/`store`/`viewer` from the graph's
 * capabilities); the actual per-request host/scheme decision always runs
 * against the *real* grant list in `network-request.ts`'s
 * `coreNetworkRequest`, via `SandboxConfig.network.grants`. A script cannot
 * widen its own access by holding the namespace open and calling a
 * different host than the grant names — every call is re-checked.
 *
 * This is the only namespace whose `call:` does real network I/O; every
 * other bridge method only touches the loaded model. It is also async by
 * necessity (`fetch` returns a Promise), which the generic `call:` /
 * `isThenable` handling in `bridge-schema.ts` already supports — see that
 * module's doc comment and `bridge-async.ts` for the `HostWorkQueue`
 * mechanism a Promise-returning `call:` rides through automatically.
 */

import type { NamespaceSchema } from './bridge-schema.js';
import { coreNetworkRequest, type FetchTransport, type NetworkMethod } from './network-request.js';
import type { Capability } from '@ifc-lite/extensions';

/** Request options a script may pass as the second argument to `bim.network.fetch`. */
interface NetworkFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

function normalizeMethod(raw: string | undefined): NetworkMethod {
  const m = (raw ?? 'GET').toUpperCase();
  if (m === 'GET' || m === 'POST') return m;
  throw new Error(`bim.network.fetch: unsupported method "${raw}" — only GET and POST are implemented`);
}

/** A script-supplied bound, or `fallback` when absent or not a finite number >= `min` (a NaN cap would read without limit). */
function boundOr(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

/** `transport` changes how the bytes move (a host's or a test's); the grant check always runs first. */
export function buildNetworkNamespace(grants: readonly Capability[], transport?: FetchTransport): NamespaceSchema {
  return {
    name: 'network',
    doc: 'Outbound HTTP requests, restricted to https: hosts covered by a granted network.fetch:<host> capability.',
    permission: 'network',
    methods: [
      {
        name: 'fetch',
        doc: 'Fetch an https: URL. `options.method` is GET (default) or POST; `options.headers`/`body` are optional. Throws if the host is not granted or the response exceeds the byte cap.',
        args: ['string', 'dump'],
        paramNames: ['url', 'options'],
        tsParamTypes: [undefined, '{ method?: "GET" | "POST"; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxBytes?: number } | undefined'],
        tsReturn: 'Promise<{ status: number; headers: Record<string, string>; body: string; truncated: boolean }>',
        call: async (_sdk, args, context) => {
          const url = args[0] as string;
          const options = (args[1] as NetworkFetchOptions | undefined) ?? {};
          return coreNetworkRequest(
            {
              url,
              method: normalizeMethod(options.method),
              headers: options.headers,
              body: options.body,
              timeoutMs: boundOr(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1),
              maxBytes: boundOr(options.maxBytes, DEFAULT_MAX_BYTES, 0),
              signal: context.hostSignal,
            },
            grants,
            transport,
          );
        },
        returns: 'value',
      },
    ],
  };
}
