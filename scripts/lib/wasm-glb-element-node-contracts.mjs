/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #9011: `exportGlbNamedByGlobalId` through the real wasm boundary. `exportGlb`
// keeps its one unnamed root; the sibling makes each element a top-level node
// named by its IFC GlobalId (a 22-character IFC GUID).

/** The JSON chunk of a GLB. */
function glbJson(glb) {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  return JSON.parse(Buffer.from(glb.buffer, glb.byteOffset + 20, dv.getUint32(12, true)).toString('utf-8'));
}

/**
 * `defaultGlb` is `api.exportGlb(content, false, new Uint32Array(), undefined, '')`,
 * which the caller already built from `content`.
 */
export function runGlbElementNodeContracts(api, test, assert, content, defaultGlb) {
  test('exportGlb keeps one unnamed root; exportGlbNamedByGlobalId names element nodes by GlobalId', () => {
    const plain = glbJson(defaultGlb);
    assert.equal(plain.scenes[0].nodes.length, 1);
    assert.ok(plain.nodes.every((n) => n.name === undefined), 'default names nothing');
    const named = glbJson(api.exportGlbNamedByGlobalId(new TextEncoder().encode(content), false, new Uint32Array(), undefined, ''));
    const top = named.scenes[0].nodes.map((i) => named.nodes[i]);
    assert.ok(top.length > 0);
    for (const node of top) {
      assert.match(node.name, /^[0-9A-Za-z_$]{22}$/, 'element node named by its GlobalId');
      assert.ok(node.children.length > 0 && node.mesh === undefined);
    }
  });
}
