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
});

describe('applyProcessingConfig', () => {
  // The host's server and start model loading for real: useIfcLoader.processedModel.test.tsx.
  it('changes nothing for a configuration without them, or none at all', () => {
    setProcessingServerUrl('/ifc');
    applyProcessingConfig({});
    applyProcessingConfig(undefined);
    assert.equal(getProcessingServerUrl(), '/ifc');
    assert.equal(takeProcessedModelRequest(), null);
  });

  it('a start model refuses the page URL, a ?room= link included', () => {
    const info = console.info;
    console.info = () => {};
    try {
      resetProcessedModelRequestsForTests();
      assert.equal(pageUrlModelAllowed('room'), true);
      applyProcessingConfig({ open: { processedModel: { sha256: 'b'.repeat(64), bytes: 0, name: 'host.ifc' } } });
      assert.equal(pageUrlModelAllowed('room'), false);
    } finally {
      console.info = info;
      resetProcessedModelRequestsForTests();
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
});
