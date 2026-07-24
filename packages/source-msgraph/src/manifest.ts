/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

import { DEFAULT_AUTHORITY } from './msal-client.js';

export const MSGRAPH_MANIFEST: PluginManifest = {
  name: 'ms-graph',
  title: 'SharePoint / OneDrive',
  api: '^2.0.0',
  permissions: {
    network: ['graph.microsoft.com', 'login.microsoftonline.com'],
    // Pre-signed download URLs — see `download()` in provider.ts. Tenant-
    // specific hosts, hence the wildcards: business tenants serve from
    // `{tenant}.sharepoint.com`, consumer OneDrive from `*.files.1drv.com`.
    publicNetwork: ['*.sharepoint.com', '*.1drv.com'],
  },
  auth: 'interactive',
  preferences: [
    {
      name: 'clientId',
      title: 'Application (client) ID',
      description:
        'The client ID of an Entra (Azure AD) app registration you control — see this ' +
        "package's README for the exact registration steps. ifc-lite ships no shared " +
        'client ID: every user brings their own.',
      type: 'textfield',
      required: true,
    },
    {
      name: 'authority',
      title: 'Authority',
      description:
        'Leave the default unless your app registration is restricted to a single tenant.',
      type: 'textfield',
      required: false,
      default: DEFAULT_AUTHORITY,
    },
  ],
  capabilities: {
    containerListing: 'direct-children',
    listFilesIsRecursive: false,
    revisionHistory: true,
    // History is listable, but its bytes are not reachable from a browser:
    // `/versions/{id}/content` answers 302 and Authorization forces a preflight.
    downloadHistoricalRevisions: false,
    changeDetection: true,
    search: true,
    // Delegated Graph has no "list every site I can see" — see README.
    projectsAreDiscoverableOnly: true,
  },
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
