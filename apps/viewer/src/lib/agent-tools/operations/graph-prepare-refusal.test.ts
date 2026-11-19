/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { resetFeaturesForTest } from '@/lib/features';
import { BACK_WALL, SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { createMainViewerToolHost } from '../main-viewer-host';
import { dispatchMainViewerTool, type AgentToolResult } from '../main-viewer-dispatch';
import { operationJob } from './executor';
import { viewerOperation } from './registry';
import type { ToolHost } from '../types';

let host: ToolHost;
const invoke = (id: string, input: unknown = {}, write = false, extra: Record<string, unknown> = {}) =>
  dispatchMainViewerTool(host, write ? 'viewer_operation_execute' : 'viewer_operation_inspect', {
    ...(viewerOperation(id).needs === 'model' ? { model_id: SAMPLE_MODEL } : {}), operation_id: id, input, ...extra,
  }, { canEdit: () => true });
function answer<T>(result: AgentToolResult): T {
  assert.equal(result.isError, false, result.text);
  const value = (result.structured as { result: { native_json?: string } }).result;
  return (value?.native_json === undefined || Object.keys(value).length > 1 ? value : JSON.parse(value.native_json)) as T;
}
async function groupProposal() {
  const store = useViewerStore.getState().models.get(SAMPLE_MODEL)!.ifcDataStore!, expressId = store.entities.getExpressIdByGlobalId(BACK_WALL);
  const evidence = answer<{ elements: Array<{ nativeGroup: { snapshot: unknown } }> }>(await invoke('authoring.nativeEvidence', { express_ids: [expressId] }));
  return JSON.stringify({ version: 1, kind: 'group.lifecycle', title: 'Exact group', modelId: SAMPLE_MODEL, expected: evidence.elements[0].nativeGroup.snapshot,
    operations: [{ op: 'group.create', params: { Name: 'Operation group', RelatedObjects: [{ expressId, GlobalId: BACK_WALL }] } }] });
}
/** An edit landing right after the graph prepare's handler returns its token, before the executor's final check. */
function editAfterEveryGraphToken() {
  const uuid = crypto.randomUUID.bind(crypto);
  return mock.method(crypto, 'randomUUID', () => {
    if (new Error().stack?.includes('authoring-graphs')) queueMicrotask(() => useViewerStore.setState(s => ({ mutationVersion: s.mutationVersion + 1 })));
    return uuid();
  });
}

describe('a graph prepare the executor refuses keeps no candidate (#10910)', () => {
  beforeEach(async () => {
    resetFeaturesForTest(); await seedAuthoringSample();
    const model = useViewerStore.getState().models.get(SAMPLE_MODEL)!;
    let maxExpressId = 0; for (const id of model.ifcDataStore!.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    useViewerStore.setState({ models: new Map([[SAMPLE_MODEL, { ...model, maxExpressId }]]) });
    host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
  });
  afterEach(() => mock.restoreAll());

  it('32 refused prepares leave the cap free for a fresh one', async () => {
    const proposal_json = await groupProposal();
    const spy = editAfterEveryGraphToken();
    for (let i = 0; i < 32; i++) {
      const refused = await invoke('authoring.group.prepare', { proposal_json });
      assert.match(refused.text, /Model replaced, closed, or edited during the operation/);
    }
    assert.equal(spy.mock.callCount() >= 32, true, 'every prepare reached its token');
    spy.mock.restore();
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
  });

  it('a refused background prepare leaves no candidate either', async () => {
    const proposal_json = await groupProposal();
    editAfterEveryGraphToken();
    for (let i = 0; i < 32; i++) {
      const { job } = (await invoke('authoring.group.prepare', { proposal_json }, false, { background: true })).structured as { job: { id: string } };
      let state = operationJob(host, job.id);
      for (let tick = 0; state.state === 'running' && tick < 1000; tick++) { await new Promise(resolve => setTimeout(resolve, 0)); state = operationJob(host, job.id); }
      assert.equal(state.state, 'failed');
      assert.match(state.error ?? '', /Model replaced, closed, or edited during the operation/);
    }
    mock.restoreAll();
    answer(await invoke('authoring.group.prepare', { proposal_json: await groupProposal() }));
  });
});
