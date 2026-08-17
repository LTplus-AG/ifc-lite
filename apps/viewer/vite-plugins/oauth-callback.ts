/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Plugin } from 'vite';

/**
 * OAuth redirect paths are extension-less (`/oauth/msgraph/callback`), because
 * they have to match the redirect URI registered with the provider byte for
 * byte and that is what is registered. Vite's dev server answers any
 * extension-less path with the SPA fallback, so the redirect used to boot a
 * whole second copy of the viewer inside a 500x700 popup.
 *
 * This maps each such path onto its static page in `public/`, which is what
 * the popup actually needs: a few lines that broadcast the result and close.
 * Production does the same thing through `vercel.json`'s rewrites, so keep
 * the two lists in lockstep.
 */
const CALLBACK_PAGES: Record<string, string> = {
  // @ifc-lite/source-msgraph, REDIRECT_PATH in its src/auth.ts.
  '/oauth/msgraph/callback': '/oauth/msgraph/callback.html',
};

export function oauthCallbackRoutes(): Plugin {
  return {
    name: 'ifc-lite-oauth-callback-routes',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? '').split('?');
        const page = CALLBACK_PAGES[path];
        // Rewrite rather than serve: Vite's own static handling then serves
        // the file from `public/`, which keeps the dev server's COOP/COEP
        // headers on the response. The query string carries `code`/`state`
        // and must survive.
        if (page) req.url = query === undefined ? page : `${page}?${query}`;
        next();
      });
    },
  };
}
