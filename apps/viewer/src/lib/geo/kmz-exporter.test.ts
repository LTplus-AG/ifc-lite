/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { MeshData, KmzAltitudeMode } from '@ifc-lite/geometry';
import { buildKmz, type KmzProcessor } from './kmz-exporter.js';

/** A stub `GeometryProcessor` slice that records how the helper drove it. */
function makeStub(result: Uint8Array | null | (() => never)) {
  const calls = {
    init: 0,
    dispose: 0,
    args: [] as Array<{
      meshes: MeshData[];
      latitude: number;
      longitude: number;
      altitude: number;
      xAxisAbscissa: number | undefined;
      xAxisOrdinate: number | undefined;
      name: string;
      altitudeMode: KmzAltitudeMode | undefined;
    }>,
  };
  const gp: KmzProcessor = {
    async init() {
      calls.init++;
    },
    exportKmzFromMeshes(meshes, latitude, longitude, altitude, xAxisAbscissa, xAxisOrdinate, name = 'IFC Model', altitudeMode) {
      calls.args.push({ meshes, latitude, longitude, altitude, xAxisAbscissa, xAxisOrdinate, name, altitudeMode });
      if (typeof result === 'function') result();
      return result as Uint8Array | null;
    },
    dispose() {
      calls.dispose++;
    },
  };
  return { gp, calls };
}

const MESHES = [{ expressId: 1 }] as unknown as MeshData[];

describe('buildKmz', () => {
  it('forwards meshes + lat/lon/alt/axes/name to the Rust exporter and returns the bytes', async () => {
    const kmz = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    const { gp, calls } = makeStub(kmz);

    const out = await buildKmz(
      {
        latLon: { lat: 47.5, lon: 8.5 },
        altitude: 412,
        xAxisAbscissa: 1,
        xAxisOrdinate: 0,
        meshes: MESHES,
        name: 'Bldg A',
      },
      () => gp,
    );

    assert.deepEqual(out, kmz);
    assert.equal(calls.init, 1);
    assert.equal(calls.dispose, 1);
    assert.deepEqual(calls.args[0], {
      meshes: MESHES,
      latitude: 47.5,
      longitude: 8.5,
      altitude: 412,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      name: 'Bldg A',
      altitudeMode: undefined,
    });
  });

  it('defaults the name and passes undefined axes through (heading 0 in Rust)', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, meshes: MESHES }, () => gp);

    assert.equal(calls.args[0].name, 'IFC Model');
    assert.equal(calls.args[0].xAxisAbscissa, undefined);
    assert.equal(calls.args[0].xAxisOrdinate, undefined);
  });

  it('defaults altitudeMode to undefined so Rust clamps the model to the ground', async () => {
    // No altitudeMode => the wasm boundary receives undefined => the Rust
    // exporter's AltitudeMode::ClampToGround default writes
    // <altitudeMode>clampToGround</altitudeMode>, so the model never floats (#1427).
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await buildKmz({ latLon: { lat: 47.5, lon: 8.5 }, altitude: 412, meshes: MESHES }, () => gp);

    assert.equal(calls.args[0].altitudeMode, undefined);
  });

  it('forwards altitudeMode "absolute" with the orthogonal height as the altitude', async () => {
    // "True elevation (MSL)" => the exporter writes <altitudeMode>absolute</altitudeMode>
    // and honours <altitude> = the model's orthogonal height.
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await buildKmz(
      { latLon: { lat: 47.5, lon: 8.5 }, altitude: 560, altitudeMode: 'absolute', meshes: MESHES },
      () => gp,
    );

    assert.equal(calls.args[0].altitudeMode, 'absolute');
    assert.equal(calls.args[0].altitude, 560, 'absolute mode carries the orthogonal height through');
  });

  it('forwards an explicit "clampToGround" altitudeMode unchanged', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await buildKmz(
      { latLon: { lat: 0, lon: 0 }, altitude: 0, altitudeMode: 'clampToGround', meshes: MESHES },
      () => gp,
    );

    assert.equal(calls.args[0].altitudeMode, 'clampToGround');
  });

  it('filters out instanced-type templates (geometryClass 2) before exporting', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));
    const meshes = [
      { expressId: 1 }, // no geometryClass: placed occurrence (default 0)
      { expressId: 2, geometryClass: 0 }, // placed occurrence
      { expressId: 3, geometryClass: 2 }, // instanced-type template: must be dropped
      { expressId: 4, geometryClass: 3 }, // material-layer slice: rendered like an occurrence
    ] as unknown as MeshData[];

    await buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, meshes }, () => gp);

    assert.deepEqual(
      calls.args[0].meshes.map((m) => (m as { expressId: number }).expressId),
      [1, 2, 4],
      'geometryClass 2 meshes are excluded; everything else passes through in order',
    );
  });

  it('throws when the exporter returns no data, still disposing', async () => {
    const { gp, calls } = makeStub(null);

    await assert.rejects(
      () => buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, meshes: MESHES }, () => gp),
      /KMZ export returned no data/,
    );
    assert.equal(calls.dispose, 1, 'dispose runs in finally even on failure');
  });

  it('disposes even when init() throws (init is inside the try)', async () => {
    let disposed = 0;
    const gp: KmzProcessor = {
      async init() {
        throw new Error('wasm init failed');
      },
      exportKmzFromMeshes() {
        throw new Error('should not reach exportKmzFromMeshes');
      },
      dispose() {
        disposed++;
      },
    };

    await assert.rejects(
      () => buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, meshes: MESHES }, () => gp),
      /wasm init failed/,
    );
    assert.equal(disposed, 1, 'dispose runs in finally when init throws');
  });
});
