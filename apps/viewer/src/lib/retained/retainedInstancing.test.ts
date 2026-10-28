/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { productMesh } from '@/test/retained-host-fixture';
import type { RetainedHostResponse, RetainedHostEvent } from './retained-protocol';
import { RetainedInstancing } from './retainedInstancing';

function candidate(expressId: number): Extract<RetainedHostEvent, { kind: 'published' }> {
  return { kind: 'published', expressId, ifcType: 'IfcBeam', marker: 'PresentationObligationsUnmet',
    obligationsUnmet: ['IfcAppearance'], meshes: [productMesh(expressId)], instanceKey: 'a'.repeat(64),
    instanceWorldFromObject: Float64Array.of(1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1) };
}

it('#7955 M11-I bounds each batch and preserves all products across flat fallback and final flush', () => {
  const windows: number[][] = [], messages: RetainedHostResponse[] = [];
  // Transport-level refusal fixture; actual Rust pairing/IFNS is tested over
  // the real WASM boundary. Here the invariant is conservation and ownership.
  const batcher = new RetainedInstancing(meshes => {
    windows.push(meshes.map(m => m.expressId));
    return { shard: new Uint8Array(), flatIndices: Uint32Array.from(meshes, (_, i) => i),
      instanceCount: 0, groupCount: 0, verificationRejections: 1 };
  }, 7, (event, transfer) => {
    messages.push(event);
    if (event.kind === 'published' && event.meshes.length) assert.equal(transfer.length, 3);
  });
  const ordinary = candidate(1);
  delete ordinary.instanceKey;
  batcher.accept(ordinary);
  assert.equal(messages.length, 1, 'ineligible products stream immediately');
  for (let i = 2; i < 256; i++) batcher.accept(candidate(i));
  assert.equal(windows.length, 0);
  assert.equal(messages.filter(m => m.kind === 'progress').length, 254, 'buffered products keep the watchdog alive');
  batcher.accept(candidate(256));
  assert.equal(windows.length, 1);
  assert.equal(windows[0].length, 255);
  for (let i = 257; i <= 263; i++) batcher.accept(candidate(i));
  batcher.flush();
  batcher.flush();
  assert.deepEqual(windows.map(w => w.length), [255, 7]);
  assert.deepEqual(messages.flatMap(m => m.kind === 'published' ? [m.expressId] : []),
    Array.from({ length: 263 }, (_, i) => i + 1), 'every failed grouping still renders its own mesh exactly once');
  assert.ok(messages.every(m => m.runId === 7));
});

it('#7955 M11-I refused products count toward the 256-product flush window', () => {
  let encoded = 0;
  const batcher = new RetainedInstancing(meshes => {
    encoded += meshes.length;
    return { shard: new Uint8Array(), flatIndices: Uint32Array.of(0), instanceCount: 0, groupCount: 0, verificationRejections: 0 };
  }, 1, () => {});
  batcher.accept(candidate(1));
  for (let i = 2; i <= 256; i++) batcher.accept({ kind: 'refused', status: 'refused',
    expressId: i, ifcType: 'IfcWall', code: 'incomplete' });
  assert.equal(encoded, 1, 'a sparse candidate cannot remain buffered across an arbitrary number of products');
});
