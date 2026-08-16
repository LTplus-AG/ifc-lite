/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const DALUX_MANIFEST: PluginManifest = {
  name: 'dalux-build',
  title: 'Dalux Box',
  api: '^2.0.0',
  auth: 'preferences',
  permissions: {
    network: ['*.dalux.com', 'dalux.com'],
    // Dalux's API sends no CORS headers, so it must be reached through the
    // app's own same-origin relay rather than directly from the browser.
    relay: {
      upstream: 'https://node1.field.dalux.com/service/api',
      path: '/api/dalux',
    },
  },
  preferences: [
    {
      name: 'apiKey',
      title: 'API key',
      description: 'Dalux API Identity key (created by a company admin).',
      type: 'password',
      required: true,
    },
  ],
  capabilities: {
    // Dalux has no per-folder listing endpoint: `folders` returns every
    // folder in a file area regardless of parent, so the whole subtree
    // comes back flattened and the host nests it client-side.
    containerListing: 'flat-subtree',
    // A file-area-level `listFiles` call returns every descendant file,
    // not just the ones directly in the area's root.
    listFilesIsRecursive: true,
    // Dalux's own UI has no per-folder "load more files" concept — it always
    // shows a folder's files as one complete set — so incremental paging in
    // the host would invent UX Dalux itself doesn't have. Keep the eager
    // sweep for this provider only; see `eagerFileSweep`'s doc comment in
    // `@ifc-lite/plugin-api` for why new providers should default off.
    eagerFileSweep: true,
    // No endpoint returns revision history for a file — only "fetch this
    // exact revision's content" if you already have its id.
    revisionHistory: false,
    // No history endpoint to enumerate, but a known revision id downloads fine.
    downloadHistoricalRevisions: true,
    // No delta feed either; `watchRevisions` polls the tracked refs.
    changeDetection: true,
    // No server-side file search endpoint.
    search: false,
  },
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
