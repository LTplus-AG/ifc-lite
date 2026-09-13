/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '../test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseGLB, parseGLBImageResources, parseGLBToMeshData } from '@ifc-lite/cache';
import { DEFAULT_GLTF_BUNDLE_LIMITS, packGltfBundle, resolveGltfModelFiles } from './gltf-bundle.js';

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

const pad4 = (value: number) => (value + 3) & ~3;

/**
 * The GLB the glTF 2.0 binary container spec says this bundle packs to, worked
 * out from the fixture alone: a 28-byte frame (12-byte header + two 8-byte
 * chunk headers), the rewritten JSON padded to 4 bytes, then one BIN chunk
 * holding the geometry followed by the texture as an extra buffer view.
 */
async function expectedGlbSize(fixture: ReturnType<typeof scanBundle>): Promise<number> {
  const json = JSON.parse(await fixture.document.text());
  const binLength = pad4(fixture.geometry.size) + pad4(fixture.texture.size);
  json.buffers = [{ byteLength: binLength }];
  json.bufferViews.push({ buffer: 0, byteOffset: pad4(fixture.geometry.size), byteLength: fixture.texture.size });
  json.images = [{ bufferView: 2, mimeType: 'image/jpeg' }];
  return 28 + pad4(new TextEncoder().encode(JSON.stringify(json)).byteLength) + binLength;
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

  it('refuses an oversized sidecar by its size alone, before reading it', async () => {
    const fixture = scanBundle();
    class UnreadableHugeFile extends File {
      override get size(): number { return DEFAULT_GLTF_BUNDLE_LIMITS.maxBundleBytes + 1; }
      override arrayBuffer(): Promise<ArrayBuffer> { return Promise.reject(new Error('oversized sidecar was read into memory')); }
    }
    const huge = new UnreadableHugeFile([new Uint8Array(36)], 'boulder.bin');
    await assert.rejects(packGltfBundle(fixture.document, [fixture.document, huge, fixture.texture]), /exceeds the 512 MiB limit at “boulder\.bin”/);
  });

  it('applies one cumulative limit across the document, geometry and textures', async () => {
    const fixture = scanBundle();
    class UnreadableTexture extends File {
      override arrayBuffer(): Promise<ArrayBuffer> { return Promise.reject(new Error('texture was read after the budget was spent')); }
    }
    const texture = new UnreadableTexture([fixture.textureBytes], 'boulder.jpg', { type: 'image/jpeg' });
    const expected = await expectedGlbSize(fixture);
    // Before a read the budget is the 28-byte GLB frame + the document + what is packed so far (4-byte aligned):
    // geometry fills it exactly, so the texture would tip the total over and is never read.
    const limits = { ...DEFAULT_GLTF_BUNDLE_LIMITS, maxBundleBytes: 28 + pad4(fixture.document.size) + pad4(fixture.geometry.size) };
    await assert.rejects(packGltfBundle(fixture.document, [fixture.document, fixture.geometry, texture], limits), /limit at “textures\/boulder\.jpg”/);
    // The limit is the finished GLB size: one byte short is refused, exactly enough is packed.
    await assert.rejects(packGltfBundle(fixture.document, [fixture.document, fixture.geometry, fixture.texture], { ...limits, maxBundleBytes: expected - 1 }), /limit at “boulder\.gltf”/);
    const packed = await packGltfBundle(fixture.document, [fixture.document, fixture.geometry, fixture.texture], { ...limits, maxBundleBytes: expected });
    assert.equal(packed.size, expected);
  });

  it('rejects a buffer view that reaches past its buffer instead of rebasing it onto the next resource', async () => {
    const fixture = scanBundle();
    for (const view of [{ buffer: 0, byteOffset: fixture.geometry.size - 4, byteLength: 24 }, { buffer: 0, byteOffset: -4, byteLength: 24 }, { buffer: 0, byteOffset: 0, byteLength: 1.5 }]) {
      const json = JSON.parse(await fixture.document.text()); json.bufferViews[1] = view;
      await assert.rejects(packGltfBundle(new File([JSON.stringify(json)], 'boulder.gltf'), [fixture.geometry, fixture.texture]), /buffer view 1 lies outside buffer 0/);
    }
  });

  it('decodes a percent-encoded data URI as octets rather than as UTF-8 text', async () => {
    const document = { asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream,%00%FF%01A', byteLength: 4 }] };
    const packed = await packGltfBundle(new File([JSON.stringify(document)], 'octets.gltf'), []);
    const { bin } = parseGLB(new Uint8Array(await packed.arrayBuffer()));
    assert.deepEqual([...bin!.subarray(0, 4)], [0x00, 0xff, 0x01, 0x41]);
    const malformed = { ...document, buffers: [{ uri: 'data:application/octet-stream,%0', byteLength: 1 }] };
    await assert.rejects(packGltfBundle(new File([JSON.stringify(malformed)], 'octets.gltf'), []), /invalid escaping/);
  });

  it('accepts data URI resources and removes selected sidecars from the model list', async () => {
    const fixture = scanBundle(), json = JSON.parse(await fixture.document.text());
    json.buffers[0].uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...new Uint8Array(await fixture.geometry.arrayBuffer())))}`;
    const standalone = new File([JSON.stringify(json)], 'standalone.gltf');
    const resolved = await resolveGltfModelFiles([standalone, fixture.texture]);
    assert.equal(resolved.length, 1); assert.equal(resolved[0].name, 'standalone.glb');
  });
});
