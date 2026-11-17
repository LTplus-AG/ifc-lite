/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Entry for a build that sets `VITE_VIEWER_CONFIG_URL` (the viewer-host-config
 * Vite plugin points `index.html` here instead of `main.tsx`). It requests
 * the host's configuration before the viewer's code is loaded, so the two
 * overlap; the stock entry keeps its single static graph.
 */

import './index.css';
import { startHostedViewer } from './lib/features/host-start';

const configUrl = import.meta.env.VITE_VIEWER_CONFIG_URL;
if (!configUrl) throw new Error('main-hosted.tsx needs VITE_VIEWER_CONFIG_URL at build time');

void startHostedViewer(document.getElementById('root')!, configUrl, {
  loadViewer: () => import('./bootstrap'),
  fetch: window.fetch.bind(window),
  pageUrl: window.location.href,
  reload: () => window.location.reload(),
  // Only the error screen needs it; a static import would hold back the request.
  loadTranslator: async () => {
    const [{ startLocales }, { resolve }] = await Promise.all([import('./i18n/locales.boot'), import('./i18n/registry')]);
    await startLocales();
    return resolve;
  },
});
