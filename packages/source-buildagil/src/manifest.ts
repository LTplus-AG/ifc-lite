/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

/** buildagil's openCDE API host; the only one this provider contacts. */
export const BUILDAGIL_API = 'https://openapi.buildagil.com';

export const BUILDAGIL_MANIFEST: PluginManifest = {
  name: 'buildagil', title: 'buildagil', api: '^2.0.0',
  // The deployment holds the OAuth client (id in the bundle, secret on its
  // server); users only sign in. No preferences.
  auth: 'interactive', preferences: [],
  permissions: {
    network: ['openapi.buildagil.com'],
    // The API and its token endpoint answer no CORS preflight, so a browser
    // host reaches both through its same-origin relay.
    relay: { upstream: BUILDAGIL_API, path: '/api/buildagil' },
  },
  capabilities: {
    sourceNamePatterns: ['*.ifc', '*.ifczip', '*.ifcxml', '*.ifcx'],
    // There is no folder endpoint: folders come from the documents' paths,
    // so the whole tree arrives with one scan.
    containerListing: 'flat-subtree', listFilesIsRecursive: false,
    revisionHistory: true, downloadHistoricalRevisions: true,
    changeDetection: false, search: true,
  },
  contributes: { fileSources: ['./src/provider.ts'] },
};
