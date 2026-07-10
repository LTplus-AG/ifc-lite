/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { PluginManifest } from '@ifc-lite/plugin-api';

export const DALUX_MANIFEST: PluginManifest = {
  name: 'dalux-build',
  title: 'Dalux Box',
  api: '^1.0.0',
  permissions: {
    network: ['field.dalux.com'],
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
      name: 'proxyUrl',
      title: 'CORS relay URL',
      description:
        'Optional URL of a CORS relay that forwards requests to field.dalux.com. ' +
        'Required for browser use; leave blank when running server-side or in a desktop shell.',
      type: 'textfield',
      required: false,
    },
  ],
  contributes: {
    fileSources: ['./src/provider.ts'],
  },
};
