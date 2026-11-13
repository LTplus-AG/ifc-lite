/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyProcessingConfig, getProcessingServerUrl, setProcessingServerUrl, takeProcessedModelRequest } from './processed-model';
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
});
