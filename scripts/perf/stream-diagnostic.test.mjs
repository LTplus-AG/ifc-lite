// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileSummary } from './stream-diagnostic.mjs';

test('#6516 CPU self-time conserves sampled time without double-counting parents', () => {
  // A real inspector-shaped numeric oracle: parent/root is never sampled,
  // despite owning both children. The three sample deltas sum to 6 ms.
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' }, children: [2, 3] },
      { id: 2, callFrame: { functionName: 'wasm-function[42]', url: 'wasm://wasm/123', columnNumber: 800 } },
      { id: 3, callFrame: { functionName: '(garbage collector)', url: '' } },
    ], samples: [2, 3, 2], timeDeltas: [1000, 2000, 3000],
  };
  const result = profileSummary(profile);
  assert.equal(result.sampledMs, 6);
  assert.equal(result.hottest.reduce((sum, entry) => sum + entry.selfMs, 0), 6);
  assert.equal(result.hottest.reduce((sum, entry) => sum + entry.percent, 0), 100);
  assert.equal(result.hottest[0].selfMs, 4);
  assert.equal(result.hottest[0].functionOffset, 800);
  assert.equal(result.hottest.some(entry => entry.label === '(root)'), false);
});

test('#6516 shareable CPU summary excludes client paths and authored names', () => {
  const privateName = 'Client name: confidential-project.ifc';
  const result = profileSummary({
    nodes: [{ id: 7, callFrame: { functionName: privateName, url: 'file:///private/client/model.ifc', columnNumber: 999 } }],
    samples: [7], timeDeltas: [1000],
  });
  assert.equal(result.hottest[0].label, 'JavaScript/other');
  assert.equal(result.hottest[0].functionOffset, undefined);
  assert.equal(JSON.stringify(result).includes(privateName), false);
  assert.equal(JSON.stringify(result).includes('/private/'), false);
});

test('#6516 empty CPU sampling remains finite', () => {
  assert.deepEqual(profileSummary({ nodes: [], samples: [], timeDeltas: [] }), { sampledMs: 0, instrumentationMs: 0, hottest: [] });
});

test('#6516 aggregates one WASM function across call stacks and separates profiler overhead', () => {
  const result = profileSummary({
    nodes: [
      { id: 2, callFrame: { functionName: 'wasm-function[42]', url: 'wasm://wasm/123', columnNumber: 800 } },
      { id: 3, callFrame: { functionName: 'wasm-function[42]', url: 'wasm://wasm/123', columnNumber: 800 } },
      { id: 4, callFrame: { functionName: 'post', url: 'node:inspector' } },
    ], samples: [2, 3, 4], timeDeltas: [1000, 3000, 20000],
  });
  assert.equal(result.sampledMs + result.instrumentationMs, 24);
  assert.equal(result.hottest.length, 1);
  assert.equal(result.hottest[0].selfMs, 4);
  assert.equal(result.hottest[0].percent, 100);
});
