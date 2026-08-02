/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportGlbFromGeometry, type GlbProcessor } from './glb.js';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';

/** A stub `GeometryProcessor` slice that records how the helper drove it. */
function makeStub(result: Uint8Array | null | (() => never)) {
  const calls = {
    init: 0,
    dispose: 0,
    exportArgs: [] as Array<{ meshes: MeshData[]; includeMetadata: boolean; lit: boolean; emissive: boolean }>,
  };
  const gp: GlbProcessor = {
    async init() {
      calls.init++;
    },
    exportGlbFromMeshes(meshes: MeshData[], includeMetadata = false, lit = true, emissive = false) {
      calls.exportArgs.push({ meshes, includeMetadata, lit, emissive });
      if (typeof result === 'function') result();
      return result as Uint8Array | null;
    },
    dispose() {
      calls.dispose++;
    },
  };
  return { gp, calls };
}

const mesh = (expressId: number): MeshData => ({ expressId }) as unknown as MeshData;
const geometry = (meshes: MeshData[]): GeometryResult => ({ meshes }) as unknown as GeometryResult;

describe('exportGlbFromGeometry', () => {
  it('assembles the GLB from the geometry result meshes and disposes the processor', async () => {
    const bytes = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"
    const { gp, calls } = makeStub(bytes);
    const meshes = [mesh(1), mesh(2)];

    const out = await exportGlbFromGeometry(geometry(meshes), {}, () => gp);

    assert.deepEqual(out, bytes);
    assert.equal(calls.init, 1, 'init called once');
    assert.equal(calls.dispose, 1, 'dispose called once');
    assert.equal(calls.exportArgs.length, 1);
    assert.deepEqual(calls.exportArgs[0].meshes, meshes, 'uses geometryResult.meshes by default');
    assert.equal(calls.exportArgs[0].includeMetadata, false, 'includeMetadata defaults to false');
    assert.equal(calls.exportArgs[0].emissive, false, 'emissive defaults to off');
  });

  it('forwards the emissive flag to the assembler (self-illuminated GLB option)', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await exportGlbFromGeometry(geometry([mesh(1)]), { includeMetadata: true, emissive: true }, () => gp);

    assert.equal(calls.exportArgs[0].emissive, true, 'emissive:true threads through to the assembler');
    assert.equal(calls.exportArgs[0].lit, true, 'lit stays true so no unlit extension pairs with emissive');
  });

  it('prefers the pre-filtered opts.meshes and forwards includeMetadata', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));
    const filtered = [mesh(7)];

    await exportGlbFromGeometry(geometry([mesh(1), mesh(2)]), { meshes: filtered, includeMetadata: true }, () => gp);

    assert.deepEqual(calls.exportArgs[0].meshes, filtered, 'opts.meshes overrides the geometry result');
    assert.equal(calls.exportArgs[0].includeMetadata, true);
  });

  it('throws when the assembler returns no data, still disposing', async () => {
    const { gp, calls } = makeStub(null);

    await assert.rejects(
      () => exportGlbFromGeometry(geometry([mesh(1)]), {}, () => gp),
      /GLB assembly returned no data/,
    );
    assert.equal(calls.dispose, 1, 'dispose runs in finally even on failure');
  });

  it('propagates assembler errors and still disposes', async () => {
    const { gp, calls } = makeStub(() => {
      throw new Error('boom');
    });

    await assert.rejects(() => exportGlbFromGeometry(geometry([mesh(1)]), {}, () => gp), /boom/);
    assert.equal(calls.dispose, 1);
  });
});
