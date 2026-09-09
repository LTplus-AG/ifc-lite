/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { it } from 'node:test';
import assert from 'node:assert/strict';
import * as collab from '@ifc-lite/collab';
import type { MeshData } from '@ifc-lite/geometry';
import { seedGeometryToRoom, hydrateGeometryFromRoom, type CollabGeomApi } from './geometry-sync.js';
import { encodeMesh, decodeMesh } from './mesh-codec.js';
import { encodeTexture, decodeTexture } from './room-texture.js';

const api: CollabGeomApi = collab;
const path = collab.guidToPath('0aBcDeFgHiJkLmNoPqRsT1');
const pixels = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128]);
function mesh(id = 1): MeshData {
  return {
    expressId: id, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1], origin: [7, 8, 9],
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { width: 2, height: 2, rgba: pixels, repeatS: false, repeatT: true },
  };
}
function session(doc = collab.createCollabDoc()) {
  return { doc, transact: (fn: () => void) => doc.transact(fn) } as collab.CollabSession;
}
function owner() {
  const result = session();
  collab.seedFromStep(result.doc, { entities: [{ guid: '0aBcDeFgHiJkLmNoPqRsT1', ifcClass: 'IfcWall' }] });
  return result;
}

// #4232 — shared-room texture loss: the recipient must recover appearance without a
// local IFCZIP, not merely geometry with a URL it cannot resolve.
it('transfers texture pixels, UVs and sampler through an independent recipient doc', async () => {
  const source = owner();
  const store = new collab.MemoryBlobStore();
  const original = mesh();
  const second = { ...original, expressId: 2 };
  const report = await seedGeometryToRoom(api, source, store, [original, second], () => path);
  assert.equal(report.seeded, 2);
  const recipient = session();
  collab.seedFromIfcx(recipient.doc, JSON.stringify(collab.snapshotToIfcx(source.doc)));
  const hashes = collab.collectReferencedBlobHashes(recipient.doc);
  assert.equal(hashes.size, 3, 'two geometry blobs and ONE shared image, all retained by GC');
  const received = await hydrateGeometryFromRoom(api, recipient, store, new Map([[path, 71]]));
  assert.equal(received.length, 2);
  for (const item of received) {
    assert.equal(item.expressId, 71);
    assert.deepEqual(item.uvs, original.uvs);
    assert.deepEqual(item.texture, original.texture);
    assert.deepEqual(item.origin, original.origin);
    assert.equal(item.textureRef, undefined, 'no source-local filename or texture id is required');
  }
  assert.equal(received[0].texture!.rgba, received[1].texture!.rgba, 'recipient decodes the shared image once');
  const later = await hydrateGeometryFromRoom(api, recipient, store);
  assert.equal(later[0].texture!.rgba, received[0].texture!.rgba, 'subsequent geometry updates reuse the GPU image identity');
  source.doc.destroy(); recipient.doc.destroy();
});

it('texture changes change mesh identity even when geometry and UVs are identical', async () => {
  const source = owner(), store = new collab.MemoryBlobStore();
  const original = mesh(), changed = mesh();
  changed.texture = { ...changed.texture!, rgba: pixels.slice().reverse() };
  await seedGeometryToRoom(api, source, store, [original], () => path);
  const first = collab.getGeometryRef(source.doc, path)!.geomIds[0];
  await seedGeometryToRoom(api, source, store, [changed], () => path, { replace: true });
  const second = collab.getGeometryRef(source.doc, path)!.geomIds[0];
  assert.notEqual(first, second);
  const result = await hydrateGeometryFromRoom(api, source, store);
  assert.deepEqual(result[0].texture!.rgba, changed.texture!.rgba);
  source.doc.destroy();
});

it('a missing image fails sharing explicitly instead of publishing a white mesh', async () => {
  const source = owner(), original = mesh();
  delete original.texture;
  original.textureRef = { textureId: 1, url: 'image.png', repeatS: true, repeatT: false };
  const report = await seedGeometryToRoom(api, source, new collab.MemoryBlobStore(), [original], () => path, { retries: 0 });
  assert.equal(report.failed, 1); assert.equal(report.seeded, 0);
  assert.match(String(report.error), /source image is unavailable/);
  source.doc.destroy();
});

it('exhausted image retries never poison the mesh cache', async () => {
  const source = owner(), store = new collab.MemoryBlobStore();
  await seedGeometryToRoom(api, source, store, [mesh()], () => path);
  const geom = collab.getGeometry(source.doc, collab.getGeometryRef(source.doc, path)!.geomIds[0])!;
  const hash = (geom.get('params') as { get(key: string): unknown }).get('textureBlobHash') as string;
  const bytes = (await store.get(hash))!;
  await store.delete(hash);
  const cache = new Map<string, MeshData>();
  const notices: string[] = [];
  assert.deepEqual(await hydrateGeometryFromRoom(api, source, store, undefined, { cache, onFailure: message => notices.push(message) }), []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /Reconnect to retry/);
  assert.equal(cache.size, 0);
  await store.put(bytes);
  assert.equal((await hydrateGeometryFromRoom(api, source, store, undefined, { cache })).length, 1);
  source.doc.destroy();
});

it('rejects truncated, oversized and inconsistent texture payloads before pixel allocation', () => {
  const bytes = encodeTexture(mesh().texture!);
  assert.deepEqual(decodeTexture(bytes).rgba, pixels);
  assert.throws(() => decodeTexture(bytes.subarray(0, 11)), /truncated/);
  assert.throws(() => decodeTexture(bytes.subarray(0, bytes.length - 1)), /payload/);
  new DataView(bytes.buffer).setUint32(4, 0xffffffff, true);
  assert.throws(() => decodeTexture(bytes), /dimensions/);
  assert.throws(() => encodeTexture({ width: 2, height: 2, rgba: new Uint8Array(3) }), /length/);
});

it('retains v2 untextured compatibility and rejects invalid v3 UVs', () => {
  const original = mesh(); delete original.texture; delete original.uvs;
  const v2 = encodeMesh(original);
  assert.equal(new DataView(v2.buffer).getUint16(4, true), 2);
  assert.deepEqual(decodeMesh(v2).origin, original.origin);
  // v1 has the same fixed prefix but no 12-byte origin slot.
  const v1 = new Uint8Array(v2.length - 12);
  v1.set(v2.subarray(0, 28)); v1.set(v2.subarray(40), 28);
  new DataView(v1.buffer).setUint16(4, 1, true);
  new DataView(v1.buffer).setUint16(6, 0, true);
  assert.deepEqual(decodeMesh(v1).positions, original.positions);
  assert.equal(decodeMesh(v1).origin, undefined);
  original.uvs = new Float32Array([0, 1]);
  assert.throws(() => encodeMesh(original, { hash: 'a'.repeat(32), repeatS: true, repeatT: true }), /UV/);
  const v3 = encodeMesh(mesh(), { hash: 'a'.repeat(32), repeatS: false, repeatT: true });
  assert.throws(() => decodeMesh(v3.subarray(0, v3.length - 1)), /length/);
  const badHash = v3.slice(); badHash[badHash.length - 1] = 33;
  assert.throws(() => decodeMesh(badHash), /reference/);
  const badUv = v3.slice();
  new DataView(badUv.buffer).setFloat32(badUv.length - 36 - 24, NaN, true);
  assert.throws(() => decodeMesh(badUv), /UV/);
});


it('one production hydrate retries a late image without another geometry update', async () => {
  const source = owner(), backing = new collab.MemoryBlobStore();
  await seedGeometryToRoom(api, source, backing, [mesh()], () => path);
  const geom = collab.getGeometry(source.doc, collab.getGeometryRef(source.doc, path)!.geomIds[0])!;
  const hash = (geom.get('params') as { get(key: string): unknown }).get('textureBlobHash') as string;
  class ReplicatingStore extends collab.MemoryBlobStore {
    imageAttempts = 0;
    override async get(key: string) {
      if (key === hash && ++this.imageAttempts < 3) return null;
      return backing.get(key);
    }
  }
  const replica = new ReplicatingStore();
  const result = await hydrateGeometryFromRoom(api, source, replica);
  assert.equal(replica.imageAttempts, 3);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].texture!.rgba, pixels);
  source.doc.destroy();
});

it('accepts the corpus 4096-square images at the decoded pixel budget boundary', () => {
  const texture = { width: 4096, height: 4096, rgba: new Uint8Array(4096 * 4096 * 4) };
  const bytes = encodeTexture(texture);
  assert.equal(bytes.length, 12 + texture.rgba.length);
  assert.throws(() => encodeTexture({ ...texture, height: 4097 }), /dimensions/);
});
