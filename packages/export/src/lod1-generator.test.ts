/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `generateLod1` (#1959 P1 leak): both the primary meshing GeometryProcessor
 * and the fallback-GLB GeometryProcessor were never disposed on any path.
 * Covers the success path (primary processor), the forced-meshing-failure
 * fallback path (both processors — the primary fails after `init()`, the
 * fallback still runs), and a GLB-assembly failure on the primary processor
 * so the `finally` around it is proven to run even when the try block
 * throws partway through.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { generateLod1 } from './lod1-generator.js';

const IFC_WITH_BOUNDING_BOX = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('lod1.ifc','2026-05-27T00:00:00',$,$,'ifc-lite','ifc-lite',$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCLOCALPLACEMENT($,#11);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((10.,20.,30.));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','BoundingBox',(#32));
#32=IFCBOUNDINGBOX(#20,2.,3.,4.);
#40=IFCWALL('wall-guid',$,'Wall',$,$,#10,#30,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;

function input(): Uint8Array {
  return new TextEncoder().encode(IFC_WITH_BOUNDING_BOX);
}

/** A trivially-empty async generator, standing in for `processAdaptive`. */
async function* emptyAdaptiveStream(): AsyncGenerator<never> {
  // No batches, no completion event — generateLod1 tolerates an empty stream.
}

/**
 * A minimal, structurally-valid GLB (magic + version + JSON chunk, no BIN
 * needed by the JSON-only fields `extractGlbMapping` reads) so
 * `extractGlbMapping` — called unconditionally after every mocked
 * `exportGlbFromMeshes` — doesn't throw on the disposal tests below, which
 * only care about the mocked GeometryProcessor's lifecycle, not real glTF
 * content.
 */
function fakeGlb(): Uint8Array {
  const json = JSON.stringify({
    nodes: [{ mesh: 0, extras: { expressId: 40 } }],
    meshes: [{}],
  });
  const jsonBytes = new TextEncoder().encode(json);
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPad;
  // Empty BIN chunk — `extractGlbMapping` never reads it, but `parseGLB`
  // requires both a JSON and a BIN chunk to be present.
  const binChunkLen = 0;
  const totalLen = 12 + 8 + jsonChunkLen + 8 + binChunkLen;

  const buf = new ArrayBuffer(totalLen);
  const dv = new DataView(buf);
  let offset = 0;
  dv.setUint32(offset, 0x46546c67, true); offset += 4; // magic 'glTF'
  dv.setUint32(offset, 2, true); offset += 4; // version
  dv.setUint32(offset, totalLen, true); offset += 4; // total length

  dv.setUint32(offset, jsonChunkLen, true); offset += 4;
  dv.setUint32(offset, 0x4e4f534a, true); offset += 4; // 'JSON'
  new Uint8Array(buf, offset, jsonBytes.length).set(jsonBytes);
  offset += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) new Uint8Array(buf, offset + i, 1)[0] = 0x20;
  offset += jsonPad;

  dv.setUint32(offset, binChunkLen, true); offset += 4;
  dv.setUint32(offset, 0x004e4942, true); offset += 4; // 'BIN\0'

  return new Uint8Array(buf);
}

describe('generateLod1 WASM disposal (#1959 P1 leak)', () => {
  // Restoring in afterEach (not at the end of each `it`) matters here: a
  // failing assertion would otherwise skip the restore and leak a spied
  // prototype method into the next test, corrupting its call count.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disposes the primary GeometryProcessor on the success path', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GeometryProcessor.prototype, 'processAdaptive').mockImplementation(emptyAdaptiveStream);
    vi.spyOn(GeometryProcessor.prototype, 'exportGlbFromMeshes').mockReturnValue(fakeGlb());
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    const result = await generateLod1(input());

    expect(result.meta.status).toBe('ok');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('disposes the primary GeometryProcessor even when GLB assembly returns no data', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GeometryProcessor.prototype, 'processAdaptive').mockImplementation(emptyAdaptiveStream);
    // Primary assembly fails -> generateLod1 falls into the catch/fallback path,
    // which uses a SECOND GeometryProcessor. Both instances share the spied
    // prototype, so the dispose count below covers both.
    vi.spyOn(GeometryProcessor.prototype, 'exportGlbFromMeshes')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(fakeGlb());
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    const result = await generateLod1(input());

    expect(result.meta.status).toBe('degraded');
    expect(result.meta.fallback).toBe('boxes_from_lod0');
    expect(disposeSpy).toHaveBeenCalledTimes(2);
  });

  it('disposes the fallback GeometryProcessor when the forced-failure test hook fires', async () => {
    vi.spyOn(GeometryProcessor.prototype, 'init').mockResolvedValue(undefined);
    vi.spyOn(GeometryProcessor.prototype, 'exportGlbFromMeshes').mockReturnValue(fakeGlb());
    const disposeSpy = vi.spyOn(GeometryProcessor.prototype, 'dispose').mockReturnValue(undefined);

    // __forceMeshingErrorForTest throws before the primary GeometryProcessor
    // is even constructed, so exactly one processor (the fallback) exists —
    // and it still must be disposed.
    const result = await generateLod1(input(), { __forceMeshingErrorForTest: true });

    expect(result.meta.status).toBe('degraded');
    expect(result.meta.fallback).toBe('boxes_from_lod0');
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });
});
