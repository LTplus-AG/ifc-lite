/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { PluginManifest } from '@ifc-lite/plugin-api';
export function manifest(clientId?: string, hosted = false): PluginManifest {
  return {
    name: 'autodesk', title: 'Autodesk Forma / Data Exchange', api: '^2.0.0', auth: 'interactive',
    permissions: {
      network: ['developer.api.autodesk.com'],
      publicNetwork: ['*.s3.amazonaws.com', '*.s3.us-west-2.amazonaws.com', '*.s3.us-east-1.amazonaws.com', '*.s3.eu-west-1.amazonaws.com', '*.s3.eu-central-1.amazonaws.com'],
    },
    preferences: hosted ? [] : [{
      name: 'clientId', title: 'Autodesk APS application ID', type: 'textfield', required: true,
      default: clientId,
      description: 'Deployment configuration. Register a public PKCE application and authorize it in the Autodesk account’s Custom Integrations. Never enter a client secret here.',
    }],
    capabilities: {
      sourceNamePatterns: [], containerListing: 'direct-children', listFilesIsRecursive: false,
      revisionHistory: true, downloadHistoricalRevisions: true, changeDetection: true, search: false,
      projectsAreDiscoverableOnly: true,
    },
    contributes: { fileSources: ['./src/provider.ts'] },
  };
}
