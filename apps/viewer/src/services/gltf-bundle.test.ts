/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '../test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGLB, parseGLBImageResources, parseGLBToMeshData } from '@ifc-lite/cache';
import { packGltfBundle, resolveGltfModelFiles } from './gltf-bundle.js';

function scanBundle() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const geometry = new Uint8Array(positions.byteLength + uvs.byteLength);
  geometry.set(new Uint8Array(positions.buffer)); geometry.set(new Uint8Array(uvs.buffer), positions.byteLength);
  const texture = new Uint8Array([255, 216, 255]);
  const document = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    buffers: [{ uri: 'boulder.bin', byteLength: geometry.byteLength }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: uvs.byteLength },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
    ],
    images: [{ uri: 'textures/boulder.jpg' }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, material: 0 }] }],
  };
  return {
    document: new File([JSON.stringify(document)], 'boulder.gltf', { type: 'model/gltf+json' }),
    geometry: new File([geometry], 'boulder.bin'), texture: new File([texture], 'boulder.jpg', { type: 'image/jpeg' }), textureBytes: texture,
  };
}

describe('glTF bundle ingestion #4476', () => {
  it('packs external geometry and a nested texture into the canonical GLB reader without changing image bytes', async () => {
    const fixture = scanBundle();
    const packed = await packGltfBundle(fixture.document, [fixture.document, fixture.geometry, fixture.texture]);
    assert.equal(packed.name, 'boulder.glb');
    const { json, bin } = parseGLB(new Uint8Array(await packed.arrayBuffer()));
    const [mesh] = parseGLBToMeshData(json, bin!);
    assert.deepEqual([...mesh.positions], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual(parseGLBImageResources(json, bin!).get(mesh.textureRef!.url), fixture.textureBytes);
  });

  it('reports missing, remote, traversal and ambiguous resources by name', async () => {
    const fixture = scanBundle();
    await assert.rejects(packGltfBundle(fixture.document, [fixture.document, fixture.texture]), /missing “boulder\.bin”/);
    for (const uri of ['https://example.com/model.bin', '../model.bin', '/model.bin', 'folder\\model.bin']) {
      const json = JSON.parse(await fixture.document.text()); json.buffers[0].uri = uri;
      await assert.rejects(packGltfBundle(new File([JSON.stringify(json)], 'unsafe.gltf'), []), /local relative file/);
    }
    await assert.rejects(packGltfBundle(fixture.document, [fixture.document, fixture.geometry, new File(['other'], 'boulder.bin'), fixture.texture]), /more than one possible “boulder\.bin”/);
  });

  it('accepts data URI resources and removes selected sidecars from the model list', async () => {
    const fixture = scanBundle(), json = JSON.parse(await fixture.document.text());
    json.buffers[0].uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(await fixture.geometry.arrayBuffer())))}`;
    const standalone = new File([JSON.stringify(json)], 'standalone.gltf');
    const resolved = await resolveGltfModelFiles([standalone, fixture.texture]);
    assert.equal(resolved.length, 1); assert.equal(resolved[0].name, 'standalone.glb');
  });
});
