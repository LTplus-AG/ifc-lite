/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const DROPBOX_MANIFEST: PluginManifest = {
  name: 'dropbox',
  title: 'Dropbox',
  api: '^2.0.0',
  auth: 'interactive',
  permissions: {
    // `api.dropboxapi.com` for every metadata/listing/search/account RPC
    // (`list_folder`, `list_folder/continue`, `list_revisions`, `search_v2`,
    // `get_current_account`). `content.dropboxapi.com` for `files/download`
    // (a *separate* host by Dropbox's own convention — RPC endpoints and
    // content endpoints are split, unlike Graph's single `graph.microsoft.com`).
    // `api.dropboxapi.com` doubles as the OAuth *token* host (`/oauth2/token`,
    // which `auth.ts`'s `exchangeAuthorizationCode`/`refreshAccessToken` call
    // through `ctx.fetch`) — same non-Graph-credential caveat as the msgraph
    // manifest documents for its own token host: that request carries no
    // bearer token, only the PKCE code/verifier exchange itself.
    //
    // `www.dropbox.com` is deliberately NOT listed: the only thing served
    // from it is the authorization *page*, which the user is navigated to in
    // a popup (`window.open`) and never fetched — an allowlist entry would
    // grant this provider a fetch capability it does not use.
    //
    // No `publicNetwork`: unlike Graph's pre-signed `@microsoft.graph.downloadUrl`
    // (a foreign CDN host reached without credentials), Dropbox's
    // `files/download` is a normal authenticated POST to `content.dropboxapi.com`
    // — see the citations in `http-client.ts` and `provider.ts` for why this
    // is safe to send bearer-authenticated through `ctx.fetch` rather than
    // routed through `ctx.fetchPublic`.
    network: ['api.dropboxapi.com', 'content.dropboxapi.com'],
  },
  // Public client (PKCE, no client_secret) — see `auth.ts`. The app key is
  // not a secret, so a plain textfield is enough, matching source-msgraph's
  // `clientId` preference.
  preferences: [
    {
      name: 'clientId',
      title: 'Dropbox app key',
      description:
        'The "App key" of the Dropbox API app used for sign-in (Dropbox App Console → your app → Settings). ' +
        'Configured by the party hosting this viewer — see the package README for what to register.',
      type: 'textfield',
      required: true,
    },
  ],
  capabilities: {
    // `files/list_folder` (and `.../continue`) is a real per-folder listing
    // endpoint scoped by `path` — no client-side sweep-and-nest needed.
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
    // `POST /2/files/list_revisions` lists up to 100 revisions for a path.
    revisionHistory: true,
    // Unlike Microsoft Graph, Dropbox's `files/download` accepts a revision
    // directly in its `path` argument as `"rev:<rev-id>"` (the separate `rev`
    // request parameter is deprecated in favor of this form) — a normal,
    // non-redirecting, CORS-safe POST to `content.dropboxapi.com`, so
    // historical bytes really are retrievable from a browser. See the
    // citation on `download()` in `provider.ts`.
    downloadHistoricalRevisions: true,
    // `files/list_folder` and `files/list_folder/continue` double as a change
    // feed: the cursor returned by an initial (optionally `recursive: true`)
    // listing can be replayed against `.../continue` to fetch only what
    // changed since, the same shape Graph's `/delta` provides. See
    // `watchRevisions()` in `provider.ts`.
    changeDetection: true,
    // `POST /2/files/search_v2`.
    search: true,
  },
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
