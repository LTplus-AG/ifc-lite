/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a user of a host application sees in the Sources panel when that host
 * registered its own providers at bootstrap (#5228): the working one is
 * listed next to the built-ins, and the one whose constructor threw is shown
 * as "failed to register", not silently absent.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PLUGIN_API_VERSION, type FileSourceProvider } from '@ifc-lite/plugin-api';
import { render, cleanup } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { BUILT_IN_PROVIDER_FACTORIES } from '@/services/sources/registered-providers';
import type { FileSourceProviderFactory } from '@/services/sources/source-host';
import { SourcesPanel } from './SourcesPanel.js';

const hostProvider: FileSourceProvider = {
  manifest: {
    name: 'acme-files',
    title: 'Acme Document Store',
    api: PLUGIN_API_VERSION,
    auth: 'preferences',
    permissions: { network: ['files.acme.example'] },
    preferences: [],
    capabilities: {
      containerListing: 'direct-children',
      listFilesIsRecursive: false,
      revisionHistory: false,
      downloadHistoricalRevisions: false,
      changeDetection: false,
      search: false,
    },
    contributes: { fileSources: [] },
  },
  listProjects: async () => ({ items: [] }),
  listContainers: async () => ({ items: [] }),
  listFiles: async () => ({ items: [] }),
  download: async () => new ArrayBuffer(0),
};

const throwing: FileSourceProviderFactory = () => {
  throw new Error('tenant not configured');
};

afterEach(cleanup);

describe('SourcesPanel with host-supplied providers (#5228)', () => {
  it('lists the host provider beside every built-in and reports the one that failed to construct', () => {
    const ui = render(
      <SourceHostProvider additionalProviders={[throwing, () => hostProvider]}>
        <SourcesPanel onClose={() => {}} />
      </SourceHostProvider>,
    );
    const text = ui.textContent ?? '';

    assert.ok(text.includes('Acme Document Store'), 'the host-supplied provider is listed');
    for (const create of BUILT_IN_PROVIDER_FACTORIES) {
      const title = create().manifest.title;
      assert.ok(text.includes(title), `built-in "${title}" is still listed`);
    }
    assert.ok(
      text.includes('host-supplied provider #1 failed to register: failed to construct: tenant not configured'),
      `the throwing provider is reported, got: ${text}`,
    );
  });
});
