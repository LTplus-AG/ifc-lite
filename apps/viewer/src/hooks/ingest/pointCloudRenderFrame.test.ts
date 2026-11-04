// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { totalYupOffset } from '@/lib/geo/coordinate-frame';
import { sharedRenderFrame } from '@/lib/render-frame/sharedRenderFrame';
import { fixtureModel } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import type { Renderer } from '@ifc-lite/renderer';
import type { PointCloudAsset } from '@ifc-lite/geometry';
import { setGlobalRendererRef } from '../useBCF.js';
import type { PointCloudAlignmentTransform } from './pointCloudAlignment.js';
import { watchPointCloudRenderFrame } from './pointCloudFrameSync.js';
import {
  applyPointCloudAlignmentToggle, reframeRegisteredPointClouds, registerPointCloudAlignment,
  retargetPointCloudDecodeOrigin, unregisterPointCloudAlignment,
} from './pointCloudAlignmentRegistry.js';

const handle = { id: 87_810 };
const writes: Array<Float32Array | Float64Array | null> = [];
const renderer = { setPointCloudTransform(_handle: { id: number }, matrix: Float32Array | Float64Array | null) { writes.push(matrix); } };
const origin: readonly [number, number, number] = [2_600_010, 1_200_020, 8];
const noOffset = { x: 0, y: 0, z: 0 };
const placeholderScan: PointCloudAsset = {
  expressId: 1,
  chunk: { positions: new Float32Array(), pointCount: 0, bbox: { min: [0, 0, 0], max: [0, 0, 0] } },
};

function ifcModel() {
  const ifc = fixtureModel('ifc');
  ifc.loadedAt = 1;
  ifc.loadState = 'complete';
  ifc.geometryResult = {
    meshes: [], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: {
      originShift: { x: 100, y: 2, z: -30 },
      wasmRtcOffset: { x: 2_599_900, y: 1_199_970, z: 3 },
      hasLargeCoordinates: true,
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
    },
  };
  return ifc;
}
const ifcOffset = () => totalYupOffset(sharedRenderFrame([ifcModel()]));

function unanchoredIfc() {
  const ifc = ifcModel();
  ifc.geometryResult!.coordinateInfo!.wasmRtcOffset = undefined;
  return ifc;
}

function scanModel() {
  const scan = fixtureModel('scan');
  scan.loadedAt = 0;
  scan.loadState = 'complete';
  scan.geometryResult = {
    meshes: [], pointClouds: [placeholderScan], totalVertices: 0, totalTriangles: 0,
    coordinateInfo: { ...unanchoredIfc().geometryResult!.coordinateInfo!, originShift: noOffset },
  };
  return scan;
}

afterEach(() => {
  unregisterPointCloudAlignment(handle.id);
  useViewerStore.setState({ models: new Map() });
  setGlobalRendererRef({ current: null });
  reframeRegisteredPointClouds(renderer, noOffset);
  writes.length = 0;
});

test('native scan and large-coordinate IFC share one render centre (#8781)', () => {
  const offset = ifcOffset();
  assert.deepEqual(offset, { x: 2_600_000, y: 5, z: -1_200_000 });
  reframeRegisteredPointClouds(renderer, offset);
  registerPointCloudAlignment(handle, undefined);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  const matrix = writes.at(-1)!;
  const scanCentre = [matrix[12], matrix[13], matrix[14]];
  const ifcCentre = [origin[0] - offset.x, origin[2] - offset.y, -origin[1] - offset.z];
  scanCentre.forEach((value, axis) => assert.ok(Math.abs(value - ifcCentre[axis]) < 1e-6));
});

test('scan before IFC reaches the same placement as scan after IFC (#8781)', () => {
  setGlobalRendererRef({ current: renderer as unknown as Renderer });
  watchPointCloudRenderFrame(renderer);
  registerPointCloudAlignment(handle, undefined);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  const ifc = ifcModel();
  useViewerStore.setState({ models: new Map([[ifc.id, ifc]]) });
  const scanFirst = [...writes.at(-1)!];
  unregisterPointCloudAlignment(handle.id);
  registerPointCloudAlignment(handle, undefined);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  assert.deepEqual([...writes.at(-1)!], scanFirst);
  const count = writes.length;
  reframeRegisteredPointClouds(renderer, ifcOffset());
  assert.equal(writes.length, count, 'unchanged frame does not write again');
});

test('scan-only model published first cannot take an unanchored IFC render frame (#8781)', () => {
  setGlobalRendererRef({ current: renderer as unknown as Renderer });
  watchPointCloudRenderFrame(renderer);
  registerPointCloudAlignment(handle, undefined);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  const scan = scanModel();
  useViewerStore.setState({ models: new Map([[scan.id, scan]]) });
  const ifc = unanchoredIfc();
  useViewerStore.setState({ models: new Map([[scan.id, scan], [ifc.id, ifc]]) });
  assert.deepEqual(sharedRenderFrame(useViewerStore.getState().models.values()), ifc.geometryResult!.coordinateInfo);
  const offset = totalYupOffset(ifc.geometryResult!.coordinateInfo);
  assert.deepEqual(Array.from(writes.at(-1)!.subarray(12, 15)),
    [origin[0] - offset.x, origin[2] - offset.y, -origin[1] - offset.z]);
});

test('IFC with meshes and point clouds remains a render frame candidate (#8781)', () => {
  const ifc = unanchoredIfc();
  ifc.geometryResult!.pointClouds = [placeholderScan];
  ifc.geometryResult!.meshes = [{ expressId: 1, positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([0, 1, 0]), indices: new Uint32Array(),
    color: [1, 1, 1, 1], origin: [0, 0, 0] }];
  assert.deepEqual(sharedRenderFrame([scanModel(), ifc]), ifc.geometryResult!.coordinateInfo);
});

test('meshless LandXML remains a render frame candidate (#8781)', () => {
  const landXml = unanchoredIfc();
  landXml.sourceSchema = 'LandXML-1.2';
  landXml.geometryResult!.meshes = [];
  assert.deepEqual(sharedRenderFrame([scanModel(), landXml]), landXml.geometryResult!.coordinateInfo);
});

test('removing the anchor restores native zero-offset placement (#8781)', () => {
  setGlobalRendererRef({ current: renderer as unknown as Renderer });
  watchPointCloudRenderFrame(renderer);
  const ifc = ifcModel();
  useViewerStore.setState({ models: new Map([[ifc.id, ifc]]) });
  registerPointCloudAlignment(handle, undefined);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  useViewerStore.setState({ models: new Map() });
  assert.deepEqual(Array.from(writes.at(-1)!.subarray(12, 15)), [origin[0], origin[2], -origin[1]]);
});

function alignedTransform(): PointCloudAlignmentTransform {
  return {
    decodeOriginOffset: [0, 0, 0], decodeOriginOffsetUnit: 'mapUnit',
    alignedMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 17, 19, -23, 1]),
    unalignedMatrix: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  };
}

test('aligned matrix remains byte-for-byte unchanged by frame updates (#8781)', () => {
  const transform = alignedTransform();
  registerPointCloudAlignment(handle, transform);
  reframeRegisteredPointClouds(renderer, ifcOffset());
  assert.deepEqual([...writes.at(-1)!], [...transform.alignedMatrix]);
});

test('alignment OFF uses the shared render frame with a georeferenced IFC (#8781)', () => {
  const transform = alignedTransform();
  registerPointCloudAlignment(handle, transform);
  retargetPointCloudDecodeOrigin(renderer, handle, origin);
  reframeRegisteredPointClouds(renderer, ifcOffset());
  applyPointCloudAlignmentToggle(renderer, false);
  assert.deepEqual(Array.from(writes.at(-1)!.subarray(12, 15)), [10, 3, -20]);
});
