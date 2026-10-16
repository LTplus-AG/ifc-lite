#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';

/**
 * #7734: the from-meshes GLB is told the frame its meshes were baked in, and
 * its root carries the restore. IFC Z-up (2 600 000.5, 1 200 000.25, 500) is
 * Y-up (2 600 000.5, 500, -1 200 000.25) on the glTF root, the same place the
 * from-bytes export puts it.
 *
 * Split out of `test-wasm-contract.mjs` (module-size ratchet).
 *
 * @param api the loaded wasm API.
 * @param test the shared test() runner from test-wasm-contract.mjs.
 */
export function runGlbFrameContract(api, test) {
  const rootOf = (glb) => {
    const len = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.slice(20, 20 + len)));
    return json.nodes[json.scenes[0].nodes[0]].translation;
  };
  const call = (world) =>
    api.exportGlbFromMeshes(
      new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      new Uint32Array([0, 1, 2]),
      new Uint32Array([3]),
      new Uint32Array([3]),
      new Float32Array([0.5, 0.5, 0.5, 1]),
      new Float64Array([0, 0, 0]),
      new Uint32Array([1]),
      false,
      true,
      false,
      world,
    );

  test('exportGlbFromMeshes restores the frame it is given on the scene root (#7734)', () => {
    const world = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2600000.5, 1200000.25, 500, 1]);
    const t = rootOf(call(world));
    // The root also carries the model's own centre, under a metre for this triangle.
    assert.ok(
      Math.abs(t[0] - 2600000.5) < 1 && Math.abs(t[1] - 500) < 1 && Math.abs(t[2] + 1200000.25) < 1,
      `root translation ${t}`,
    );
    // No frame: the baked frame, as before.
    const bare = rootOf(call(undefined));
    assert.ok(!bare || bare.every((v) => Math.abs(v) < 1), `unshifted root translation ${bare}`);
    assert.throws(
      () => call(new Float64Array([1, 2, 3])),
      (e) => e instanceof Error && e.message.startsWith('MALFORMED_MESH_INPUT'),
      'a world matrix that is not 16 numbers must throw MALFORMED_MESH_INPUT',
    );
  });
}
