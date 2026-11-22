/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { FlowDocument } from '@ifc-lite/flow';
import { flowRegistry } from './runner';
import { admitAgentFlowEffects } from './agent-effect-admission';

const graph = (type: string): FlowDocument => ({
  flowVersion: 1, id: 'g', name: 'g', capabilities: [], inputs: [], outputs: [], nodes: [{ id: 'n', type }], edges: [],
}) as unknown as FlowDocument;

it('an agent flow that downloads a wired URL waits for approval like an http.request (#10591 review)', () => {
  const admission = admitAgentFlowEffects(graph('documents.download'), flowRegistry(), {});
  assert.equal(admission.admitted, false);
  assert.deepEqual(admission.publication, ['n']);
});
