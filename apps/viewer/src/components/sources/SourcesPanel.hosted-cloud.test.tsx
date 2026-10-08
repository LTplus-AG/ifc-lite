/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { FileSourceProvider } from '@ifc-lite/plugin-api';
import { render, cleanup } from '@/test/render.js';
import { SourceHostProvider } from '@/services/sources/SourceHostProvider';
import { HostedCloudClient } from '@/services/sources/hosted-cloud-client';
import { hostedDropbox } from '@/services/sources/hosted-cloud-providers';
import { SourcesPanel } from './SourcesPanel';
afterEach(cleanup);
describe('SourcesPanel hosted sign-in (#6840)', () => {
  it('restores a gateway account and enables browsing without asking for app keys or tokens', async () => {
    const base = hostedDropbox(new HostedCloudClient('dropbox', async (input) => {
      assert.equal(String(input), '/api/cloud/dropbox/session');
      return Response.json({ csrf: 'test', configured: true, identity: { id: 'account', displayName: 'Cloud Test Account' } });
    }));
    // Isolate the hosted deployment provider alongside the default built-ins.
    const provider: FileSourceProvider = { manifest: { ...base.manifest, name: 'hosted-dropbox-test', title: 'Hosted Dropbox' }, auth: base.auth,
      listProjects: base.listProjects.bind(base), listContainers: base.listContainers.bind(base),
      listFiles: base.listFiles.bind(base), download: base.download.bind(base) };
    let ui!: HTMLElement;
    await act(async () => {
      ui = render(<SourceHostProvider additionalProviders={[() => provider]}><SourcesPanel onClose={() => {}} /></SourceHostProvider>);
      // Keep registration-time auth restoration inside one async act scope,
      // including the built-ins that resolve after network/preference awaits.
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    assert.ok(ui.textContent?.includes('Cloud Test Account'));
    const browse = ui.querySelector('button[aria-label="Browse Hosted Dropbox"]');
    assert.ok(browse, 'hosted source has a browse action'); assert.equal(browse.hasAttribute('disabled'), false);
    assert.equal(base.manifest.preferences.length, 0, 'deployment-managed auth has no user app configuration');
  });
});
