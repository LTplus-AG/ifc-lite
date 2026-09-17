/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The MCP playground's `clash_bcf_export` writes BCF cameras in IFC world
 * coordinates (#4879).
 *
 * The playground meshes with `GeometryProcessor.process`, which hands back
 * render-frame meshes: the wasm RTC offset (IFC Z-up) and a CoordinateHandler
 * origin shift (Y-up) already subtracted. Clash bounds come straight off
 * those meshes, so a BCF written without the frame put the camera hundreds of
 * kilometres from a georeferenced building in every other BCF tool.
 *
 * The mesher is stubbed with two overlapping boxes in that render frame plus
 * the `coordinateInfo` recording both shifts, which is exactly what the
 * dispatcher receives from the real one.
 */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type GeometryResult, type MeshData } from '@ifc-lite/geometry';
import { readBCF } from '@ifc-lite/bcf';
import { dispatch, parsePlaygroundModel } from './playground-dispatcher.js';
import { playgroundFiles } from './playground-files.js';

type Vec = { x: number; y: number; z: number };

const RTC_IFC: Vec = { x: 41266.679, y: 308208.972, z: 125.95 };
const SHIFT_YUP: Vec = { x: 1800, y: -35, z: -2600 };

function ifc4(body: string): string {
  return [
    'ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', body, 'ENDSEC;', 'END-ISO-10303-21;', '',
  ].join('\n');
}

/** An axis-aligned box as a closed triangle mesh (Y-up render frame). */
function box(expressId: number, min: Vec, max: Vec): MeshData {
  const corners: number[] = [];
  for (const z of [min.z, max.z]) for (const y of [min.y, max.y]) for (const x of [min.x, max.x]) corners.push(x, y, z);
  // Corner index = x + 2y + 4z (0/1 per axis); two triangles per face.
  const faces = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const indices = faces.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
  return {
    expressId,
    positions: new Float32Array(corners),
    normals: new Float32Array(corners.length),
    indices: new Uint32Array(indices),
    color: [1, 1, 1, 1],
  };
}

describe('playground clash_bcf_export writes world-coordinate cameras (#4879)', () => {
  it('adds the RTC offset and the origin shift to the viewpoint camera', async () => {
    // World clash centre, and the same point in the render frame the mesher
    // hands back: IFC minus RTC, swapped to Y-up (x, z, -y), minus the shift.
    const worldCentre: Vec = { x: RTC_IFC.x + 1810.5, y: RTC_IFC.y + 2593, z: RTC_IFC.z - 34 };
    const ifcLocal = { x: worldCentre.x - RTC_IFC.x, y: worldCentre.y - RTC_IFC.y, z: worldCentre.z - RTC_IFC.z };
    const c: Vec = { x: ifcLocal.x - SHIFT_YUP.x, y: ifcLocal.z - SHIFT_YUP.y, z: -ifcLocal.y - SHIFT_YUP.z };

    const meshes = [
      box(1, { x: c.x - 1.5, y: c.y - 1, z: c.z - 1 }, { x: c.x + 0.5, y: c.y + 1, z: c.z + 1 }),
      box(2, { x: c.x - 0.5, y: c.y - 1, z: c.z - 1 }, { x: c.x + 1.5, y: c.y + 1, z: c.z + 1 }),
    ];
    const bounds = { min: { x: c.x - 2, y: c.y - 1, z: c.z - 1 }, max: { x: c.x + 2, y: c.y + 1, z: c.z + 1 } };
    const result = {
      meshes,
      totalTriangles: 24,
      totalVertices: 16,
      coordinateInfo: {
        originShift: SHIFT_YUP,
        wasmRtcOffset: RTC_IFC,
        originalBounds: bounds,
        shiftedBounds: bounds,
        hasLargeCoordinates: true,
      },
    } satisfies GeometryResult;

    const initMock = mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
    const processMock = mock.method(GeometryProcessor.prototype, 'process', async () => result);
    const disposeMock = mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
    try {
      const bytes = new TextEncoder().encode(ifc4([
        "#1=IFCBUILDINGELEMENTPROXY('1a2B3c4D5e6F7g8H9i0Jcc',$,'Box A',$,$,$,$,$,$);",
        "#2=IFCBUILDINGELEMENTPROXY('2k3L4m5N6o7P8q9R0s1Tdd',$,'Box B',$,$,$,$,$,$);",
      ].join('\n')));
      const model = await parsePlaygroundModel(bytes.buffer as ArrayBuffer, 'far-site-4879.ifc');

      const out = await dispatch(model, 'clash_bcf_export', { group_by: 'rule' });
      assert.equal(out.isError, false, JSON.stringify(out));
      const fileId = (out.structured as { fileId: string }).fileId;
      const file = playgroundFiles.list().find((f) => f.id === fileId);
      assert.ok(file, 'the export staged a .bcfzip');
      const project = await readBCF(await file.blob.arrayBuffer());

      const cameras = [...project.topics.values()].flatMap((t) => t.viewpoints.map((vp) => vp.perspectiveCamera));
      assert.ok(cameras.length > 0, 'at least one clash topic with a camera');
      for (const camera of cameras) {
        assert.ok(camera);
        const eye = camera.cameraViewPoint;
        const gap = Math.hypot(eye.x - worldCentre.x, eye.y - worldCentre.y, eye.z - worldCentre.z);
        assert.ok(gap < 15, `camera ${JSON.stringify(eye)} is ${gap.toFixed(1)} m from the world clash ${JSON.stringify(worldCentre)}`);
      }
    } finally {
      initMock.mock.restore();
      processMock.mock.restore();
      disposeMock.mock.restore();
    }
  });
});
