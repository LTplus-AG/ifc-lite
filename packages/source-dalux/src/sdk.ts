/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ============================================================================
// The full Dalux Build endpoint catalogue, over this package's own client.
//
// `dalux-build-api/web` carries every endpoint group Dalux publishes —
// tasks, forms, users, companies, work packages, inspection plans, test
// plans, project templates — with zod models for their responses. This
// module borrows that catalogue without borrowing its transport: the
// adapter below drives `BrowserDaluxApiClient`, so the relay routing, node
// selector, byte-exact handling of signed links and `ctx.log` tracing that
// this package already got right all still apply.
//
// WHY THIS IS A SEPARATE ENTRY POINT (`@ifc-lite/source-dalux/sdk`)
//
// `DaluxBuildProvider` is imported statically by the viewer, so everything
// reachable from this package's MAIN entry is in the eagerly loaded bundle.
// The endpoint catalogue costs zod plus ~70 KB of schemas — which is exactly
// why the provider's own request paths stopped using this library and went
// to the hand-written decoders in `dalux-types.ts`. Nothing here is reachable
// from `index.ts`, so that bundle is unchanged; a caller that wants the
// catalogue opts in, and should prefer a dynamic import:
//
// ```ts
// const { createDaluxSdk } = await import('@ifc-lite/source-dalux/sdk');
// const dalux = createDaluxSdk(await createDaluxClient(ctx));
// const tasks = await dalux.tasks.getProjectTasks(projectId);
// ```
//
// The provider's own paths deliberately do NOT go through this. They work,
// they are covered by tests against recorded Dalux responses, and routing
// them through zod would put a stricter parser in front of live data for no
// behaviour the provider needs.
// ============================================================================

import {
  createWebClientFrom,
  type DaluxBinaryResponse,
  type DaluxHttpClient,
  type DaluxRequestConfig,
  type DaluxWebClient,
} from 'dalux-build-api/web';

import type { BrowserDaluxApiClient } from './http-client.js';

export type { DaluxWebClient } from 'dalux-build-api/web';
export type { BrowserDaluxApiClient } from './http-client.js';
/** Re-exported so one import of this subpath is enough to get a client. */
export { createDaluxClient } from './client-factory.js';

/**
 * Thrown for a write through the SDK.
 *
 * The Dalux provider is read-only — its manifest declares no write
 * capability, and `BrowserDaluxApiClient` has no write verbs — so the
 * adapter cannot honour one. Failing here is the point: silently dropping a
 * `POST` would let a caller believe it had created something.
 */
export class DaluxReadOnlyError extends Error {
  constructor(method: string, path: string) {
    super(`Dalux source is read-only: refusing ${method} ${path}`);
    this.name = 'DaluxReadOnlyError';
  }
}

/**
 * Adapts this package's client to the shape `dalux-build-api` expects.
 *
 * Exported separately from {@link createDaluxSdk} so a caller can hand it to
 * one API class (`new TasksApi(http)`) instead of constructing all sixteen.
 */
export function asDaluxHttpClient(client: BrowserDaluxApiClient): DaluxHttpClient {
  return {
    // No `apiKey`: the key stays inside `BrowserDaluxApiClient`, which is
    // what authenticates every request. Only the library's Node-only
    // file-streaming helper reads it, and that is not reachable from here.
    configuration: { baseUrl: client.baseUrl },

    get: <T>(path: string, params: Record<string, unknown> = {}, config: DaluxRequestConfig = {}) =>
      client.get(path, params, config.signal) as Promise<T>,

    post: <T>(path: string): Promise<T> => {
      throw new DaluxReadOnlyError('POST', path);
    },
    patch: <T>(path: string): Promise<T> => {
      throw new DaluxReadOnlyError('PATCH', path);
    },
    delete: <T>(path: string): Promise<T> => {
      throw new DaluxReadOnlyError('DELETE', path);
    },

    // `getBinary` reports no content type, so neither does this. The field
    // is optional in the contract precisely for a transport that doesn't
    // surface response headers; guessing one from the URL's extension would
    // be a fabricated header, not a missing one.
    binary: async (url: string, config: DaluxRequestConfig = {}): Promise<DaluxBinaryResponse> => ({
      bytes: await client.getBinary(url, config.signal),
    }),
  };
}

/**
 * Every Dalux Build endpoint group, routed through `client`.
 *
 * Reads return zod-parsed models from `dalux-build-api`; writes throw
 * {@link DaluxReadOnlyError}. Pagination is per call: each method fetches one
 * page and returns the envelope, including the `links` a caller follows to
 * get the next bookmark. This package's own `fetchAllPages` is not wired in
 * — its stuck-bookmark and page-ceiling guards are written against a path
 * string, and a caller sweeping an endpoint here should reach for it
 * directly rather than get a silently truncated listing.
 */
export function createDaluxSdk(client: BrowserDaluxApiClient): DaluxWebClient {
  return createWebClientFrom(asDaluxHttpClient(client));
}
