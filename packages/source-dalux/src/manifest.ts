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
    {
      name: 'baseUrl',
      title: 'API base URL',
      description:
        'Shown next to your API key in Dalux, e.g. https://node2.field.dalux.com/service/api. ' +
        'Leave blank for node1.',
      type: 'textfield',
      required: false,
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
    /**
     * Dalux has no per-file revision endpoint — only "fetch this exact
     * revision's content" if you already have its id. What it has is
     * version sets: `GET /2.1/projects/{p}/version_sets` plus
     * `GET /3.0/.../version_sets/{vs}/files` enumerate every revision a
     * project's snapshots pinned, which `listRevisions` sweeps and
     * reconstructs per file (`commit-index.ts`). The capability describes
     * what the provider can answer, not which single endpoint the upstream
     * API happens to publish for it.
     */
    revisionHistory: true,
    // A known revision id downloads fine, which is what makes the
    // reconstructed history above usable rather than merely informative.
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
