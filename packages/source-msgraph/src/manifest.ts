/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const MSGRAPH_MANIFEST: PluginManifest = {
  name: 'msgraph-onedrive',
  title: 'OneDrive / SharePoint',
  api: '^2.0.0',
  auth: 'interactive',
  permissions: {
    // `graph.microsoft.com` for every Graph API call (listing, metadata,
    // delta) — the single global Graph host, which sends CORS headers for
    // SPAs registered with a `spa` redirect URI, so no relay is needed here
    // unlike Dalux. `login.microsoftonline.com` for the authorization-code
    // and refresh-token exchanges in `auth.ts` (`@ifc-lite/oauth-pkce`'s
    // `exchangeAuthorizationCode`/`refreshAccessToken`), which also go
    // through `ctx.fetch` and are therefore checked against this same list —
    // that request carries no bearer token (it's the PKCE code/verifier
    // exchange itself), so this isn't a case of sending Graph credentials
    // to a different host.
    network: ['graph.microsoft.com', 'login.microsoftonline.com'],
    // Pre-signed `@microsoft.graph.downloadUrl` values point at a
    // tenant/CDN-specific host that isn't knowable at build time: OneDrive
    // Consumer serves them from `*.files.1drv.com`, OneDrive for
    // Business/SharePoint from `*.sharepoint.com` (observed as both the
    // `<tenant>.sharepoint.com` and `<tenant>-my.sharepoint.com` forms, both
    // matched by the same wildcard). See `download()` in `provider.ts` for
    // why these URLs are fetched via `ctx.fetchPublic` rather than
    // `ctx.fetch`.
    publicNetwork: ['*.sharepoint.com', '*.files.1drv.com'],
  },
  // The interactive-auth doc on `PluginAuthKind` (`@ifc-lite/plugin-api`)
  // says preferences may still be declared "alongside" interactive auth.
  // Used here for exactly what isn't allowed to be committed: the Azure AD
  // app registration's client id, and the tenant to sign into. Neither is a
  // secret — this is a public client (PKCE, no client_secret) — so a plain
  // textfield is enough; there's no API key to protect.
  preferences: [
    {
      name: 'clientId',
      title: 'Azure AD application (client) ID',
      description:
        'The Application (client) ID of the Azure AD app registration used for sign-in. ' +
        'Configured by the party hosting this viewer — see the package README for what ' +
        'to register.',
      type: 'textfield',
      required: true,
    },
    {
      name: 'tenant',
      title: 'Tenant',
      description:
        'Azure AD tenant to authenticate against. Use "common" (default) to allow both work/school ' +
        'and personal Microsoft accounts, "organizations" for work/school accounts only, or a specific ' +
        'tenant ID/domain to restrict sign-in to one organization.',
      type: 'textfield',
      required: false,
      default: 'common',
    },
  ],
  capabilities: {
    // Graph has a real per-folder `/children` endpoint — no need to sweep
    // and nest client-side the way Dalux's flat folder listing requires.
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
    // `GET /items/{id}/versions` lists history.
    revisionHistory: true,
    // Listing history and fetching its bytes are different capabilities
    // (see the doc comment on `downloadHistoricalRevisions` in
    // `@ifc-lite/plugin-api`, which names this exact provider as the
    // motivating case): a `driveItemVersion` exposes no
    // `@microsoft.graph.downloadUrl`, and `GET .../versions/{id}/content`
    // 302-redirects to a preauthenticated URL the same way the current-content
    // endpoint does — a redirect a browser can't follow while attaching the
    // `Authorization` header a CORS preflight requires. See the comment on
    // `download()` in `provider.ts` for the citation on the *current*-content
    // case; the historical-version endpoint is undocumented for
    // `@microsoft.graph.downloadUrl` and was verified to expose no such
    // property via the `driveItemVersion` resource (`docs/resources/driveitemversion`,
    // Microsoft Learn, checked 2026-08-15) and no CORS-safe alternative.
    downloadHistoricalRevisions: false,
    // `GET /me/drive/root/delta` is a real change feed.
    changeDetection: true,
    // `GET /me/drive/root/search(q='...')`.
    search: true,
  },
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
