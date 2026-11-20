/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Its own file: each test file runs in a fresh process, so no family module is cached before the first call here.
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { EMPTY_SOURCE_BYTES, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { resetFeaturesForTest } from '@/lib/features';
import { model, parseHelloWall, seed, status, viewerHost } from '@/test/agent-tools-fixture';
import { dispatchMainViewerTool } from './main-viewer-dispatch';
import { operationLoaders } from './operations/generated/loaders';
import { viewerOperation } from './operations/registry';

const initial = useViewerStore.getState();
afterEach(() => { mock.restoreAll(); useViewerStore.setState(initial); resetFeaturesForTest(); });
const execute = (host: ReturnType<typeof viewerHost>, args: Record<string, unknown>) =>
  dispatchMainViewerTool(host, 'viewer_operation_execute', args, { canEdit: () => true });

test('a keyed retry runs again after the operation family failed to load (#10669)', async () => {
  resetFeaturesForTest();
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, mutationVersion: 0, envExposure: 1 });
  const host = viewerHost();
  const broken = mock.method(operationLoaders, 'environment', () => Promise.reject(new Error('Failed to fetch dynamically imported module')));
  const request = { operation_id: 'environment.exposure', input: { value: 1.2 }, idempotency_key: 'retry' };
  const failed = await execute(host, request);
  assert.equal(failed.isError, true);
  assert.match(failed.text, /dynamically imported module/);
  broken.mock.restore();
  const retried = await execute(host, request);
  assert.equal(retried.isError, false, retried.text);
  assert.equal(useViewerStore.getState().envExposure, 1.2);
});

test('a keyed failure after the native handler ran is replayed, not run twice', async () => {
  resetFeaturesForTest();
  useViewerStore.setState({ models: new Map(), ifcDataStore: null, mutationVersion: 0, envExposure: 1 });
  const host = viewerHost();
  let runs = 0;
  mock.method(viewerOperation('environment.exposure'), 'execute', async () => { runs++; throw new Error('native refusal'); });
  const request = { operation_id: 'environment.exposure', input: { value: 1.3 }, idempotency_key: 'once' };
  assert.equal((await execute(host, request)).isError, true);
  assert.equal((await execute(host, request)).isError, true);
  assert.equal(runs, 1);
});

test('units.read refuses a model without STEP source, as the native units tool does (#10669)', async () => {
  resetFeaturesForTest();
  seed([model('synthetic', { ...(await parseHelloWall()), source: EMPTY_SOURCE_BYTES } as IfcDataStore)]);
  const result = await execute(viewerHost(), { model_id: 'synthetic', operation_id: 'units.read', input: {} });
  assert.equal(result.isError, true, result.text);
  assert.equal(result.errorCode, 'UNSUPPORTED_OPERATION');
  assert.equal(status(result), 'no-step-source');
});
