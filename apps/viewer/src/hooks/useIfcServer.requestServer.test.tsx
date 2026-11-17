/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
(globalThis as { __VITE_ENV__?: Record<string, unknown> }).__VITE_ENV__ = {
  MODE: 'test', VITE_USE_SERVER: 'true', VITE_IFC_SERVER_URL: '/global-processor',
};
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IfcServerClient } from '@ifc-lite/server-client';
const { useIfcServer } = await import('./useIfcServer');
const { openProcessedModel, getProcessingServerUrl, serverUploadsEnabled, resetProcessedModelRequestsForTests } = await import('@/lib/processed-model');

it('a host server override never redirects a local upload with server uploads enabled (#10142)', async () => {
  const destinations: string[] = [];
  let upload: File | undefined;
  let api: ReturnType<typeof useIfcServer> | undefined;
  function Probe() { api = useIfcServer(); return null; }
  const container = document.createElement('div');
  const root = createRoot(container);
  mock.method(IfcServerClient.prototype, 'health', async function (this: IfcServerClient) {
    destinations.push((this as unknown as { baseUrl: string }).baseUrl);
    return { status: 'ok' };
  });
  mock.method(IfcServerClient.prototype, 'isParquetSupported', async () => true);
  mock.method(IfcServerClient.prototype, 'parseParquet', async function (this: IfcServerClient, file: File) {
    destinations.push((this as unknown as { baseUrl: string }).baseUrl);
    upload = file;
    throw new Error('stop after observing upload destination');
  });
  mock.method(console, 'error', () => {});
  try {
    openProcessedModel({ sha256: 'a'.repeat(64), bytes: 1, name: 'host.ifc' }, { serverUrl: '/host-processor' });
    assert.equal(getProcessingServerUrl(), '/global-processor');
    assert.equal(serverUploadsEnabled(), true);
    await act(async () => { root.render(<Probe />); });
    const file = new File(['ISO-10303-21;'], 'local.ifc');
    await act(async () => { await api!.loadFromServer(file, new ArrayBuffer(12), undefined, undefined, 'local'); });
    assert.equal(upload, file);
    assert.deepEqual(destinations, ['/global-processor', '/global-processor']);
  } finally {
    await act(async () => root.unmount());
    mock.restoreAll();
    resetProcessedModelRequestsForTests();
  }
});
