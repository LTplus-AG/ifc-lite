/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '../../test/setup-dom.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepareModelFiles } from './usePreparedModelFileRoute.js';

/** A standalone glTF 2.0 document whose only buffer is embedded, so packing needs no sidecar. */
function gltfDocument(name: string, Ctor: typeof File = File): File {
  const json = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }] };
  return new Ctor([JSON.stringify(json)], name, { type: 'model/gltf+json' });
}

/** Reads its JSON only after a delay, standing in for a large bundle on a slow disk. */
class SlowFile extends File {
  override text(): Promise<string> {
    return new Promise(resolve => setTimeout(() => resolve(super.text()), 30));
  }
}

const handle = (name: string): FileSystemFileHandle => ({ kind: 'file', name } as unknown as FileSystemFileHandle);

describe('prepared model file routing #4476', () => {
  it('routes picks in the order they were made even when an earlier bundle resolves later', async () => {
    const routed: string[][] = [];
    const route = (files: File[]) => { routed.push(files.map(file => file.name)); };
    const slow = prepareModelFiles([gltfDocument('scan.gltf', SlowFile)], undefined, route);
    const fast = prepareModelFiles([new File(['ISO-10303-21;'], 'model.ifc')], undefined, route);
    await Promise.all([slow, fast]);
    assert.deepEqual(routed, [['scan.glb'], ['model.ifc']]);
  });

  it('keeps each ordinary file beside its own handle in a mixed pick and gives the packed GLB none', async () => {
    let routed: { files: File[]; handles?: (FileSystemFileHandle | undefined)[] } | undefined;
    const ifc = new File(['ISO-10303-21;'], 'model.ifc'), ifcHandle = handle('model.ifc');
    const picked = [gltfDocument('scan.gltf'), new File([new Uint8Array(4)], 'scan.bin'), ifc];
    await prepareModelFiles(picked, [handle('scan.gltf'), handle('scan.bin'), ifcHandle], (files, handles) => { routed = { files, handles }; });
    assert.deepEqual(routed?.files.map(file => file.name), ['model.ifc', 'scan.glb']);
    assert.deepEqual(routed?.handles, [ifcHandle, undefined]);
  });

  it('reports a broken bundle to its own pick without stalling the next one', async () => {
    const routed: string[] = [];
    const broken = { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'missing.bin' }] };
    const failed = prepareModelFiles([new File([JSON.stringify(broken)], 'broken.gltf')], undefined, () => { routed.push('broken'); });
    const next = prepareModelFiles([new File(['ISO-10303-21;'], 'model.ifc')], undefined, files => { routed.push(files[0].name); });
    await assert.rejects(failed, /missing “missing\.bin”/);
    await next;
    assert.deepEqual(routed, ['model.ifc']);
  });

  it('rejects sidecars picked without their .gltf by name instead of loading nothing', async () => {
    // .bin and images pass the entry-point filters so they can travel beside a
    // document; alone they used to resolve to [] and return silently.
    let routed = false;
    const sidecars = [new File([new Uint8Array(4)], 'scan.bin'), new File([new Uint8Array(8)], 'scan.png', { type: 'image/png' })];
    await assert.rejects(prepareModelFiles(sidecars, undefined, () => { routed = true; }), /\.gltf document together with its \.bin and texture files/);
    assert.equal(routed, false);
  });
});
