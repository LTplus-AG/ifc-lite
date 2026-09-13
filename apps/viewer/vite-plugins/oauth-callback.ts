/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { loadEnv, type Plugin } from 'vite';

/**
 * OAuth redirect paths are extension-less (`/oauth/dropbox/callback`,
 * `/oauth/msgraph/callback`, one per provider), because
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
  // @ifc-lite/source-dropbox, REDIRECT_PATH in its src/auth.ts.
  '/oauth/dropbox/callback': '/oauth/dropbox/callback.html',
  // @ifc-lite/source-msgraph, REDIRECT_PATH in its src/auth.ts.
  '/oauth/msgraph/callback': '/oauth/msgraph/callback.html',
  // BCF server connector, BCF_OAUTH_REDIRECT_PATH in src/services/bcf-server.ts.
  '/oauth/bcf/callback': '/oauth/bcf/callback.html',
};

/**
 * A BCF vendor app configured through `VITE_BCF_APP_<PRESET>_REDIRECT_URI`
 * (see `vendorAppForPreset` in src/components/viewer/bcf/bcf-server-presets.ts)
 * may register a callback path of the vendor's choosing — BIMcollab's
 * playground client is pinned to `http://localhost:5000/Callback` — and
 * that path needs the same static page. Only the dev server learns it
 * from the env; production serves the default path via vercel.json, so a
 * production app registers that.
 */
function configuredBcfCallbackPaths(env: Record<string, string>): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^VITE_BCF_APP_[A-Z0-9_]+_REDIRECT_URI$/.test(key) || !value) continue;
    try {
      paths.push(new URL(value).pathname);
    } catch {
      // Not a URL; the form reports that when the user tries to sign in.
    }
  }
  return paths;
}

export function oauthCallbackRoutes(): Plugin {
  const pages: Record<string, string> = { ...CALLBACK_PAGES };
  return {
    name: 'ifc-lite-oauth-callback-routes',
    config(config, { mode }) {
      const envDir = config.envDir ?? config.root ?? process.cwd();
      for (const path of configuredBcfCallbackPaths(loadEnv(mode, envDir, 'VITE_'))) {
        pages[path] ??= CALLBACK_PAGES['/oauth/bcf/callback'];
      }
    },
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path, query] = (req.url ?? '').split('?');
        const page = pages[path];
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
