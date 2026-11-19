/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyProcessingConfig, getProcessingServerUrl, openProcessedModelFromUrl, pageUrlModelAllowed, processedModelRequested, resetProcessedModelRequestsForTests, setProcessingServerUrl, takeProcessedModelRequest } from './processed-model';
import { isServerReachable } from '@/hooks/ingest/serverAvailability';

const initial = getProcessingServerUrl();
afterEach(() => setProcessingServerUrl(initial));

describe('setProcessingServerUrl', () => {
  it('keeps "/" as the page origin instead of clearing the server', () => {
    setProcessingServerUrl('/');
    assert.equal(getProcessingServerUrl(), '/');
    assert.equal(isServerReachable(getProcessingServerUrl()), true);
    setProcessingServerUrl('//');
    assert.equal(getProcessingServerUrl(), '/');
  });

  it('drops trailing slashes from any other URL, and clears on an empty string', () => {
    setProcessingServerUrl('/ifc/');
    assert.equal(getProcessingServerUrl(), '/ifc');
    setProcessingServerUrl('https://server.example.org//');
    assert.equal(getProcessingServerUrl(), 'https://server.example.org');
    setProcessingServerUrl('');
    assert.equal(getProcessingServerUrl(), '');
  });

  it('trims spaces, and reads a blank or missing value as no server', () => {
    setProcessingServerUrl(' /ifc/ ');
    assert.equal(getProcessingServerUrl(), '/ifc');
    setProcessingServerUrl('   ');
    assert.equal(getProcessingServerUrl(), '');
    setProcessingServerUrl(undefined as unknown as string); // an untyped host
    assert.equal(getProcessingServerUrl(), '');
  });
});

describe('applyProcessingConfig', () => {
  // How a filed request loads: useIfcLoader.processedModel.test.tsx; mountViewer's call: bootstrap.tsx.
  it('changes nothing for a configuration without them, or none at all', () => {
    try {
      setProcessingServerUrl('/ifc');
      applyProcessingConfig({});
      applyProcessingConfig(undefined);
      assert.equal(getProcessingServerUrl(), '/ifc');
      assert.equal(takeProcessedModelRequest(), null);
    } finally {
      setProcessingServerUrl(initial);
    }
  });

  it('names the server, then files the start model as a host request that the page URL yields to', () => {
    const info = console.info;
    console.info = () => {};
    try {
      resetProcessedModelRequestsForTests();
      assert.equal(pageUrlModelAllowed('room'), true);
      applyProcessingConfig({
        server: { url: '/v1/viewing/processor' },
        open: { processedModel: { sha256: 'b'.repeat(64), bytes: 0, name: 'host.ifc' } },
      });
      assert.equal(getProcessingServerUrl(), '/v1/viewing/processor');
      assert.equal(pageUrlModelAllowed('room'), false);
      assert.deepEqual(takeProcessedModelRequest(), { sha256: 'b'.repeat(64), bytes: 0, name: 'host.ifc' });
    } finally {
      console.info = info;
      resetProcessedModelRequestsForTests();
      setProcessingServerUrl(initial);
    }
  });
});

describe('processedModelRequested', () => {
  afterEach(() => resetProcessedModelRequestsForTests());

  it('turns on with any processed-model request, so the browser fast path stays off', () => {
    resetProcessedModelRequestsForTests();
    assert.equal(processedModelRequested(), false);
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: 'page.ifc' });
    assert.equal(processedModelRequested(), true);
    takeProcessedModelRequest();
    assert.equal(processedModelRequested(), true, 'stays on after the viewer took the request');
  });

  it('reads a ?processed= link once, at load: a valid one counts before its request is filed, a malformed one never', async () => {
    const before = location.href;
    const fresh = async (search: string) => {
      history.replaceState(null, '', search);
      const module = await import(`./processed-model?link=${encodeURIComponent(search)}`) as typeof import('./processed-model');
      history.replaceState(null, '', before);
      return module.processedModelRequested(); // the URL has changed back by now
    };
    try {
      assert.equal(await fresh(`?processed=${'A'.repeat(64)}`), true);
      for (const search of ['?processed=', '?processed=abc', '?model=x.ifc']) assert.equal(await fresh(search), false, search);
    } finally {
      history.replaceState(null, '', before);
    }
  });

  it('trims the name of every request, and falls back to model.ifc for a blank one', () => {
    resetProcessedModelRequestsForTests();
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: '  Haus A.ifc  ' });
    assert.equal(takeProcessedModelRequest()?.name, 'Haus A.ifc');
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: '   ' });
    assert.equal(takeProcessedModelRequest()?.name, 'model.ifc');
  });
});
