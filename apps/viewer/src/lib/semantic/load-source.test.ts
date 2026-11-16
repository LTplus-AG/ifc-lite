/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { DEFAULT_PROFILE } from '@ifc-lite/semantic';
import { useSemanticSession } from './session';
import { useViewerStore } from '@/store';
import { executeValidation } from './validation-job';
import { loadSemanticSource } from './load-source';
const payload = JSON.stringify({ profile: DEFAULT_PROFILE.id, source: 'https://example.test/native-records', completeness: 'partial', resources: [] });
const input = { mode: 'local', payload, endpoint: '', host: '', query: '', mapping: {} };
it('native semantic retrieval refuses stale datasets after real validation (#10525)', async () => {
  useSemanticSession.getState().setProfile(DEFAULT_PROFILE); useSemanticSession.getState().setGraph('preserved');
  let release!: () => void; const paused = new Promise<void>(resolve => { release = resolve; });
  const pending = loadSemanticSource(input, new AbortController().signal, async job => { const result = await executeValidation(job); await paused; return result; });
  useViewerStore.setState({ models: new Map(useViewerStore.getState().models) }); release();
  await assert.rejects(pending, /models changed/); assert.equal(useSemanticSession.getState().graph, 'preserved');
});
it('native semantic retrieval applies its commit boundary before replacing actual validated records (#10525)', async () => {
  useSemanticSession.getState().setGraph('reviewed graph');
  await assert.rejects(loadSemanticSource(input, new AbortController().signal, executeValidation, undefined, () => { throw new Error('Native grant revoked'); }), /grant revoked/);
  assert.equal(useSemanticSession.getState().graph, 'reviewed graph');
});
