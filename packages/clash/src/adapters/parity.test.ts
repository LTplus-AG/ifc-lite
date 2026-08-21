/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cross-adapter agreement test: the SAME logical model — one wall with two
 * mesh representations (Body + Axis) plus one non-physical IfcSpace —
 * expressed once as STEP and once as IFCX, must produce the SAME shape of
 * `ClashElement[]` from both `elementsFromStep` and `elementsFromIfcx`:
 * the space dropped, the wall's two meshes coalesced into one element.
 *
 * This is the test that actually prevents the two divergences this file's
 * sibling tests (`step.test.ts`'s coalescing tests, `ifcx.test.ts`'s
 * non-clashable-class test) each pin in isolation from drifting apart again
 * — a reader should not be able to tell which adapter produced which result.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import type { MeshData as StepMeshData } from '@ifc-lite/geometry';
import { elementsFromStep } from './step.js';
import { elementsFromIfcx } from './ifcx.js';

const WALL_GUID = '3vB2YO$MX4xv5uCqZZG05x';
const SPACE_GUID = '1aB2cD3eF4gH5iJ6kL7mN8';

const STEP_IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('parity.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('${WALL_GUID}',$,'Parity Wall',$,$,$,$,$,$);
#2=IFCSPACE('${SPACE_GUID}',$,'Parity Space',$,$,$,$,$,.ELEMENT.,$,$);
ENDSEC;
END-ISO-10303-21;
`;

function solidBoxMesh(expressId: number, ox: number): StepMeshData {
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  const positions = new Float32Array(c.flatMap(([x, y, z]) => [x + ox, y, z]));
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  return {
    expressId,
    ifcType: 'IfcWall',
    positions,
    normals: new Float32Array(positions.length),
    indices,
    color: [0.5, 0.5, 0.5, 1],
  };
}

function cubeMesh(ox: number, oy: number, oz: number, size: number) {
  const s = size;
  const points: number[][] = [
    [ox, oy, oz], [ox + s, oy, oz], [ox + s, oy + s, oz], [ox, oy + s, oz],
    [ox, oy, oz + s], [ox + s, oy, oz + s], [ox + s, oy + s, oz + s], [ox, oy + s, oz + s],
  ];
  const faceVertexIndices = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return { points, faceVertexIndices };
}

function buildIfcxFile() {
  const ifcClass = (code: string) => ({
    code,
    uri: `https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/${code}`,
  });

  return {
    header: {
      id: 'clash-parity-fixture',
      ifcxVersion: 'ifcx_alpha',
      dataVersion: '1.0.0',
      author: 'ifc-lite clash adapter test',
      timestamp: '2025-01-01T00:00:00Z',
    },
    imports: [],
    schemas: {
      'bsi::ifc::class': { value: { dataType: 'Object' as const } },
      'usd::usdgeom::mesh': { value: { dataType: 'Object' as const } },
    },
    data: [
      {
        path: 'Project',
        attributes: { 'bsi::ifc::class': ifcClass('IfcProject') },
        children: { Wall: 'Project/Wall', Space: 'Project/Space' },
      },
      {
        // Same logical entity as the STEP wall: two mesh representations.
        path: 'Project/Wall',
        attributes: { 'bsi::ifc::class': ifcClass('IfcWall') },
        children: { Body: 'Project/Wall/Body', Axis: 'Project/Wall/Axis' },
      },
      { path: 'Project/Wall/Body', attributes: { 'usd::usdgeom::mesh': cubeMesh(0, 0, 0, 1) } },
      { path: 'Project/Wall/Axis', attributes: { 'usd::usdgeom::mesh': cubeMesh(10, 0, 0, 1) } },
      {
        // Same logical entity as the STEP space: non-physical, must be dropped.
        path: 'Project/Space',
        attributes: { 'bsi::ifc::class': ifcClass('IfcSpace') },
        children: { Body: 'Project/Space/Body' },
      },
      { path: 'Project/Space/Body', attributes: { 'usd::usdgeom::mesh': cubeMesh(20, 0, 0, 1) } },
    ],
  };
}

function ifcxBuffer(): ArrayBuffer {
  return new TextEncoder().encode(JSON.stringify(buildIfcxFile())).buffer as ArrayBuffer;
}

describe('elementsFromStep / elementsFromIfcx agree on the same logical model', () => {
  it('both drop the non-physical IfcSpace and coalesce the wall\'s two meshes into one element', async () => {
    const store = await new IfcParser().parseColumnar(
      new TextEncoder().encode(STEP_IFC).buffer as ArrayBuffer,
    );
    const wallId = (store.entityIndex.byType.get('IFCWALL') ?? [])[0];
    const spaceId = (store.entityIndex.byType.get('IFCSPACE') ?? [])[0];
    expect(wallId).toBeGreaterThan(0);
    expect(spaceId).toBeGreaterThan(0);

    const stepResult = elementsFromStep({
      store,
      // Two mesh representations of the wall (mirrors IFCX's Body + Axis)
      // plus the space's single mesh.
      meshes: [solidBoxMesh(wallId, 0), solidBoxMesh(wallId, 10), solidBoxMesh(spaceId, 20)],
      modelId: 'parity-model',
    });

    const ifcxResult = await elementsFromIfcx({
      buffer: ifcxBuffer(),
      modelId: 'parity-model',
    });

    // Same COUNT: one element (the wall), the space dropped by both.
    expect(stepResult.elements).toHaveLength(1);
    expect(ifcxResult.elements).toHaveLength(1);

    // Same TAG.
    expect(stepResult.elements[0].tag).toBe('IfcWall');
    expect(ifcxResult.elements[0].tag).toBe('IfcWall');

    // Same GEOMETRY SHAPE: both merged two 8-vertex/36-index cubes into one
    // 16-vertex/72-index buffer, neither adapter left a duplicate element or
    // a truncated (single-mesh) one behind.
    expect(stepResult.elements[0].positions.length).toBe(8 * 3 * 2);
    expect(ifcxResult.elements[0].positions.length).toBe(8 * 3 * 2);
    expect(stepResult.elements[0].indices.length).toBe(36 * 2);
    expect(ifcxResult.elements[0].indices.length).toBe(36 * 2);

    // Same BOUNDS on the axis both encodings agree on (world x is preserved
    // by IFCX's Z-up -> Y-up conversion; y/z are remapped, so only x is
    // compared cross-adapter). The union spans both sub-meshes on both
    // adapters, not just one of them.
    expect(stepResult.elements[0].bounds.min).toEqual([0, 0, 0]);
    expect(stepResult.elements[0].bounds.max).toEqual([11, 1, 1]);
    expect(ifcxResult.elements[0].bounds.min[0]).toBe(0);
    expect(ifcxResult.elements[0].bounds.max[0]).toBe(11);
  });
});
