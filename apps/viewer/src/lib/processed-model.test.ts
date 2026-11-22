/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyProcessingConfig, getProcessingServerUrl, openProcessedModel, openProcessedModelFromUrl, pageUrlModelAllowed, processedModelRequested, resetProcessedModelRequestsForTests, setProcessingServerUrl, takeProcessedModelRequest } from './processed-model';
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

  it('reports a missing server in the config and still files the model for the error card (#10822)', (t) => {
    const error = t.mock.method(console, 'error', () => {});
    const processedModel = { sha256: 'b'.repeat(64), bytes: 0, name: 'host.ifc' };
    try {
      setProcessingServerUrl('');
      applyProcessingConfig({ open: { processedModel } });
      assert.deepEqual(takeProcessedModelRequest(), processedModel);
      assert.equal(error.mock.callCount(), 1);
      assert.match(String(error.mock.calls[0].arguments[0]), /viewer config.*open\.processedModel.*server\.url/i);
    } finally {
      resetProcessedModelRequestsForTests();
    }
  });

  it('uses an existing processing server when the config supplies only the model (#10822)', (t) => {
    const error = t.mock.method(console, 'error', () => {});
    const processedModel = { sha256: 'b'.repeat(64), bytes: 0, name: 'host.ifc' };
    try {
      setProcessingServerUrl('/ifc');
      applyProcessingConfig({ open: { processedModel } });
      assert.deepEqual(takeProcessedModelRequest(), processedModel);
      assert.equal(error.mock.callCount(), 0);
    } finally {
      resetProcessedModelRequestsForTests();
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

  it('opens the bootstrap option first and uses the returned handle for later requests (#10469)', () => {
    resetProcessedModelRequestsForTests();
    try {
      const configured = { sha256: 'b'.repeat(64), bytes: 0, name: 'configured.ifc' };
      const first = { sha256: 'a'.repeat(64), bytes: 0, name: 'startup.ifc' };
      const later = { sha256: 'c'.repeat(64), bytes: 50, name: 'later.ifc' };

      const handle = applyProcessingConfig({
        server: { url: '/default/' },
        open: { processedModel: configured },
      }, { ...first, serverUrl: '/initial/' });

      assert.deepEqual(takeProcessedModelRequest(), { ...first, serverUrl: '/initial' });
      assert.equal(takeProcessedModelRequest(), null);
      assert.equal(getProcessingServerUrl(), '/default');
      assert.throws(() => handle.openProcessedModel({ ...later, sha256: 'invalid' }), TypeError);
      assert.equal(takeProcessedModelRequest(), null);

      handle.setProcessingServerUrl('/new-default/');
      handle.openProcessedModel(later, { serverUrl: '/next/' });

      assert.deepEqual(takeProcessedModelRequest(), { ...later, serverUrl: '/next' });
      assert.equal(getProcessingServerUrl(), '/new-default');
    } finally {
      resetProcessedModelRequestsForTests();
    }
  });
});

it('applies host precedence to a malformed processed link before reporting it (#10469)', () => {
  const info = console.info;
  const logged: string[] = [];
  console.info = (message: string) => { logged.push(message); };
  resetProcessedModelRequestsForTests();
  try {
    assert.equal(openProcessedModelFromUrl('malformed'), 'malformed');
    assert.equal(takeProcessedModelRequest(), null);
    assert.equal(processedModelRequested(), false);

    const host = { sha256: 'a'.repeat(64), bytes: 0, name: 'Host.ifc' };
    openProcessedModel(host);
    assert.equal(openProcessedModelFromUrl('malformed'), undefined);
    assert.equal(openProcessedModelFromUrl('malformed'), undefined);
    assert.deepEqual(takeProcessedModelRequest(), host);
    assert.equal(logged.length, 1);
  } finally {
    console.info = info;
    resetProcessedModelRequestsForTests();
  }
});

describe('processedModelRequested', () => {
  afterEach(() => resetProcessedModelRequestsForTests());

  it('blocks warm-up only while a request waits to be taken (#10822)', () => {
    resetProcessedModelRequestsForTests();
    assert.equal(processedModelRequested(), false);
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: 'page.ifc' });
    assert.equal(processedModelRequested(), true);
    takeProcessedModelRequest();
    assert.equal(processedModelRequested(), false, 'the load now owns the request');
  });

  it('blocks idle warm-up for a traced processed URL before React files the request (#10822)', () => {
    const sha256 = 'a'.repeat(64);
    try {
      window.history.replaceState(null, '', `/?processed=${sha256}&perfTrace=1`);
      assert.equal(processedModelRequested(), true, 'the URL is visible while the tracer is still loading');
      openProcessedModelFromUrl({ sha256, bytes: 0, name: 'page.ifc' });
      assert.equal(processedModelRequested(), true, 'the filed request still waits for the loader');
      assert.ok(takeProcessedModelRequest());
      assert.equal(processedModelRequested(), false, 'the URL does not keep the gate closed after handoff');
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  it('does not block warm-up for a malformed processed URL (#10822)', () => {
    try {
      window.history.replaceState(null, '', '/?processed=invalid&perfTrace=1');
      assert.equal(processedModelRequested(), false);
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });
});

describe('openProcessedModelFromUrl', () => {
  afterEach(() => resetProcessedModelRequestsForTests());

  it('trims the URL request name and falls back to model.ifc for a blank one', () => {
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: '  Haus A.ifc  ' });
    assert.equal(takeProcessedModelRequest()?.name, 'Haus A.ifc');
    openProcessedModelFromUrl({ sha256: 'a'.repeat(64), bytes: 0, name: '   ' });
    assert.equal(takeProcessedModelRequest()?.name, 'model.ifc');
  });
});
