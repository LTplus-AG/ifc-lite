/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildKmz, type KmzProcessor } from './kmz-exporter.js';

/** A stub `GeometryProcessor` slice that records how the helper drove it. */
function makeStub(result: Uint8Array | null | (() => never)) {
  const calls = {
    init: 0,
    dispose: 0,
    args: [] as Array<{
      glb: Uint8Array;
      latitude: number;
      longitude: number;
      altitude: number;
      xAxisAbscissa: number | undefined;
      xAxisOrdinate: number | undefined;
      name: string;
    }>,
  };
  const gp: KmzProcessor = {
    async init() {
      calls.init++;
    },
    exportKmz(glb, latitude, longitude, altitude, xAxisAbscissa, xAxisOrdinate, name = 'IFC Model') {
      calls.args.push({ glb, latitude, longitude, altitude, xAxisAbscissa, xAxisOrdinate, name });
      if (typeof result === 'function') result();
      return result as Uint8Array | null;
    },
    dispose() {
      calls.dispose++;
    },
  };
  return { gp, calls };
}

const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46]); // "glTF"

describe('buildKmz', () => {
  it('forwards lat/lon/alt/axes/name to the Rust exporter and returns the bytes', async () => {
    const kmz = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    const { gp, calls } = makeStub(kmz);

    const out = await buildKmz(
      {
        latLon: { lat: 47.5, lon: 8.5 },
        altitude: 412,
        xAxisAbscissa: 1,
        xAxisOrdinate: 0,
        glb: GLB,
        name: 'Bldg A',
      },
      () => gp,
    );

    assert.deepEqual(out, kmz);
    assert.equal(calls.init, 1);
    assert.equal(calls.dispose, 1);
    assert.deepEqual(calls.args[0], {
      glb: GLB,
      latitude: 47.5,
      longitude: 8.5,
      altitude: 412,
      xAxisAbscissa: 1,
      xAxisOrdinate: 0,
      name: 'Bldg A',
    });
  });

  it('defaults the name and passes undefined axes through (heading 0 in Rust)', async () => {
    const { gp, calls } = makeStub(new Uint8Array([1]));

    await buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, glb: GLB }, () => gp);

    assert.equal(calls.args[0].name, 'IFC Model');
    assert.equal(calls.args[0].xAxisAbscissa, undefined);
    assert.equal(calls.args[0].xAxisOrdinate, undefined);
  });

  it('throws when the exporter returns no data, still disposing', async () => {
    const { gp, calls } = makeStub(null);

    await assert.rejects(
      () => buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, glb: GLB }, () => gp),
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
      exportKmz() {
        throw new Error('should not reach exportKmz');
      },
      dispose() {
        disposed++;
      },
    };

    await assert.rejects(
      () => buildKmz({ latLon: { lat: 0, lon: 0 }, altitude: 0, glb: GLB }, () => gp),
      /wasm init failed/,
    );
    assert.equal(disposed, 1, 'dispose runs in finally when init throws');
  });
});
