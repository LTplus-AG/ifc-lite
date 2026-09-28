/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const DALUX_MANIFEST: PluginManifest = {
  name: 'dalux-build',
  title: 'Dalux Box',
  // `^2.1.0` now: the manifest declares `capabilities.commits`, which a 2.0.0
  // host does not understand — it would register this provider and then
  // never call a single commit method, leaving the History panel empty with
  // no explanation. Refusing to register is the honest failure.
  api: '^2.1.0',
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
    // No endpoint returns revision history for a file — only "fetch this
    // exact revision's content" if you already have its id.
    revisionHistory: false,
    // No history endpoint to enumerate, but a known revision id downloads fine.
    downloadHistoricalRevisions: true,
    // No delta feed either; `watchRevisions` polls the tracked refs.
    changeDetection: true,
    // No server-side file search endpoint.
    search: false,
    /**
     * Version sets ARE a commit history (contract 2.1.0). Dalux has no
     * per-file revision listing, but `GET /2.1/projects/{p}/version_sets`
     * plus `GET /3.0/.../version_sets/{vs}/files` enumerate every revision a
     * project's snapshots pinned, and `/2.0/.../revisions/{r}/content`
     * downloads them — which is exactly a model's history.
     *
     * Everything past the five required reads is off, and each for a
     * concrete reason rather than "not yet": Dalux stores files, not parsed
     * models, so it can compute no fingerprints, no diffs and no element
     * history; it records no reviewed element identity; and this provider is
     * read-only (`write`). `watch` is off because detecting a new version
     * set means re-sweeping every set — `watchRevisions` already covers
     * "did the file change" at a fraction of the cost.
     */
    commits: {
      // What the bytes are is decided per commit by the file's extension;
      // all three are reachable because a file area holds all three.
      payloadFormats: ['ifc-step', 'ifc-zip', 'ifcx'],
      fingerprints: false,
      storedDiffs: false,
      elementHistory: false,
      identityRecords: false,
      write: false,
      watch: false,
      // A model IS a file here, so a host holding only a `SourceTag` can
      // open the History panel for a model it loaded through the ordinary
      // file browser.
      modelIdsAreFileIds: true,
    },
  },
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
