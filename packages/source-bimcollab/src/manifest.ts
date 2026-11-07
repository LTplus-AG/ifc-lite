/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';
export const BIMCOLLAB_MANIFEST: PluginManifest = {
  name: 'bimcollab', title: 'BIMcollab', api: '^2.0.0',
  // Authentication is supplied by the host's existing BCF session. No second login.
  auth: 'preferences', preferences: [],
  permissions: {
    network: ['api.eu.bimcollab.com', '*.bimcollab.com'],
    publicNetwork: ['*.blob.core.windows.net'],
    // No `relay` declaration: the host's relay rewrite maps one upstream prefix to
    // one path, but /api/bimcollab has two route families. The host injects a
    // same-origin fetch bound to /api/bimcollab instead (see README).
  },
  capabilities: {
    sourceNamePatterns: ['*.ifc', '*.ifczip', '*.ifcxml', '*.ifcx'],
    containerListing: 'direct-children', listFilesIsRecursive: false,
    revisionHistory: true, downloadHistoricalRevisions: true,
    changeDetection: false, search: true,
  },
  contributes: { fileSources: ['./src/provider.ts'] },
};
