/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginContext } from '@ifc-lite/plugin-api';

import { BrowserDaluxApiClient } from './http-client.js';
import { parseDaluxNode } from './node-url.js';

/**
 * The canonical Dalux API host. Not company-specific, so it is not a setting
 * — see {@link createDaluxClient} for what a non-default node changes.
 */
const DEFAULT_BASE_URL = 'https://node1.field.dalux.com/service/api';

/**
 * Builds an authenticated client from a `PluginContext`.
 *
 * A free function rather than a method: it reads nothing but the context, and
 * the commit surface (`commit-methods.ts`) needs it as much as the file
 * surface does. Keeping it on the provider class forced the commit methods to
 * be bound per instance just to reach `this`.
 *
 * `baseUrl` stays the canonical default even for a non-default node: the host
 * only rewrites to the same-origin relay while the URL matches the manifest's
 * declared upstream, and Dalux serves no CORS headers, so a rewritten base
 * would bypass the relay and fail in the browser. The node travels as a
 * parameter the relay resolves server-side (#2792).
 */
export async function createDaluxClient(ctx: PluginContext): Promise<BrowserDaluxApiClient> {
  const apiKey = await ctx.getPreference('apiKey');
  if (!apiKey) throw new Error('Dalux API key not configured');
  const node = parseDaluxNode(await ctx.getPreference('baseUrl'));
  return new BrowserDaluxApiClient({ baseUrl: DEFAULT_BASE_URL, apiKey, node }, ctx);
}
