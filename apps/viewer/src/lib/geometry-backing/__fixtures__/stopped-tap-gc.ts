/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { createStore } from 'zustand/vanilla';
import type { MeshData } from '@ifc-lite/geometry';
import { StoreGeometryBackingTap, type TapState } from '../store-backing-tap';

async function stoppedTap() {
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const reference = new WeakRef(positions);
  const mesh: MeshData = { expressId: 1, positions, normals: new Float32Array(9),
    indices: Uint32Array.from([0, 1, 2]), color: [1, 1, 1, 1] };
  const store = createStore<TapState>(() => ({
    models: new Map(), geometryContentVersion: 0,
  }));
  // Zustand retains its initial state separately; do not make that a second owner.
  store.setState({ models: new Map([['m', { geometryResult: { meshes: [mesh] } }]]) });
  const tap = await StoreGeometryBackingTap.start(store, {
    database: { name: `stopped-tap-gc-${process.pid}`, locks: null },
  });
  assert.equal((await tap.seal())[0].complete, true);
  await tap.stop();
  // Remove the model's legitimate owner, but deliberately keep the stopped
  // tap alive. Its acknowledged-generation cache must no longer pin arrays.
  store.setState({ models: new Map() });
  return { tap, reference };
}

export async function stoppedTapGc(): Promise<void> {
  assert.ok(globalThis.gc, 'this retention witness requires --expose-gc');
  const held = await stoppedTap();
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    globalThis.gc();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (held.reference.deref() === undefined) break;
  }
  assert.equal(held.reference.deref(), undefined, 'a retained stopped tap must not pin acknowledged mesh arrays');
  assert.deepEqual(held.tap.status(), [], 'the tap itself is still referenced');
}
