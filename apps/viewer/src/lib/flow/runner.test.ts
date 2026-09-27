/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `FlowSecretUnavailableError` is the viewer's pre-flight guard for
 * #5167 phase 3.5: the browser's `HostFeatures.secrets` is always empty
 * (`BROWSER_FEATURES`), so a graph referencing `{{secret:NAME}}` must be
 * refused BEFORE `runFlow` starts, not mid-run once some other node has
 * already written to the model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { BimContext } from '@ifc-lite/sdk';
import type { FlowDocument, MemoCache } from '@ifc-lite/flow';
import { FlowSecretUnavailableError, runFlowInViewer } from './runner.js';

function doc(overrides: Partial<FlowDocument>): FlowDocument {
  return { flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [], nodes: [], edges: [], ...overrides };
}

const fakeCache = { invalidate: () => {} } as unknown as MemoCache;

describe('runFlowInViewer — secrets are never available in the browser', () => {
  it('refuses a graph referencing {{secret:NAME}} before running any node', async () => {
    const d = doc({
      capabilities: ['secret.read:API_TOKEN'],
      nodes: [{ id: 'req', type: 'http.request', params: { url: 'https://x/?t={{secret:API_TOKEN}}' } }],
    });
    await assert.rejects(
      () => runFlowInViewer({ doc: d, bim: {} as BimContext, pin: 'p', cache: fakeCache }),
      (err: unknown) => {
        assert.ok(err instanceof FlowSecretUnavailableError);
        assert.deepEqual(err.names, ['API_TOKEN']);
        return true;
      },
    );
  });

  it('de-duplicates a secret referenced by more than one node/param', async () => {
    const d = doc({
      capabilities: ['secret.read:API_TOKEN'],
      nodes: [
        { id: 'a', type: 'http.request', params: { url: 'https://x/?t={{secret:API_TOKEN}}' } },
        { id: 'b', type: 'http.request', params: { body: '{{secret:API_TOKEN}}' } },
      ],
    });
    await assert.rejects(
      () => runFlowInViewer({ doc: d, bim: {} as BimContext, pin: 'p', cache: fakeCache }),
      (err: unknown) => {
        assert.ok(err instanceof FlowSecretUnavailableError);
        assert.deepEqual(err.names, ['API_TOKEN']);
        return true;
      },
    );
  });
});
