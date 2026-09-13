/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared tail of every BCF server sign-in flow, and the lazy loader for
 * `@ifc-lite/bcf-api` (a dynamic import so the connector stays out of the
 * entry bundle until a user actually connects). Split out of
 * `bcf-server.ts` so the browser OAuth flow (`bcf-server-oauth.ts`) and the
 * password / token / client-credentials flows (`bcf-server.ts`) share it
 * without importing each other.
 */

import { saveBcfServerConfig } from './bcf-server-config.js';
import type { BcfServerConfig } from './bcf-server-config.js';

export function loadApi() {
  return import('@ifc-lite/bcf-api');
}

/**
 * Resolve the signed-in identity for a fresh token set, persist the
 * connection, and hand it back. Shared tail of every sign-in flow.
 */
export async function completeSignIn(
  baseUrl: string,
  token: { access_token: string; refresh_token?: string; expires_in?: number },
  appCredentials?: { clientId: string; clientSecret: string },
): Promise<BcfServerConfig> {
  const api = await loadApi();
  const client = new api.BcfApiClient({ baseUrl, getAccessToken: () => token.access_token });
  const user = await client.getCurrentUser();
  const config: BcfServerConfig = {
    serverUrl: baseUrl,
    userId: user.id,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? '',
    tokenExpiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : 0,
    clientId: appCredentials?.clientId ?? '',
    clientSecret: appCredentials?.clientSecret ?? '',
    projectId: '',
    projectName: '',
  };
  saveBcfServerConfig(config);
  return config;
}
