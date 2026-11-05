/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { PlyStreamingSource } from '@ifc-lite/pointcloud';
import { positionedGaussianChunks } from '@ifc-lite/renderer';
import { PositionedPly } from './ply';
import { exportPositionedScan, positionedScanColumns } from './scan';
import { positionedExportSnapshot, restoreGaussianOrigin } from './frame';
import { decodeGaussianFile } from '@/hooks/ingest/gaussianDecode';
import { gaussianPly } from '@/test/gaussian-loader-harness';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { registerPointCloudAlignment, unregisterPointCloudAlignment, retargetPointCloudDecodeOrigin } from '@/hooks/ingest/pointCloudAlignmentRegistry';

import { ZERO_ROTATION } from '@/lib/model-placement/rotation';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const signal = () => new AbortController().signal;
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const sourcePly = () => new Blob([`ply\nformat ascii 1.0\nelement vertex 3\nproperty double x\nproperty double y\nproperty double z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nproperty float nx\nproperty float ny\nproperty float nz\nproperty ushort intensity\nproperty uchar classification\nend_header\n5000000.001 10 20 255 0 0 1 0 0 123 42\n5000000.002 12 24 0 255 0 0 1 0 456 128\n5000000.003 14 28 0 0 255 0 0 1 789 255\n`]);

it('positioned scan download round-trips all original rows and millimetres at survey coordinates', async () => {
  const matrix = [...identity]; matrix[12] = 5000000.125; matrix[13] = -2; matrix[14] = 3;
  const source = new PlyStreamingSource(sourcePly(), { originOffset: [5000000, 0, 0] });
  const progress: number[] = [];
  const blob = await exportPositionedScan(source, matrix, signal(), n => progress.push(n));
  const reader = new PlyStreamingSource(blob, { originOffset: [5000000, 0, 0] });
  try {
    const info = await reader.open(); assert.equal(info.totalPointCount, 3);
    const chunk = await reader.next(10); assert.ok(chunk);
    [0.126, 8, 23, 0.127, 10, 27, 0.128, 12, 31].forEach((v, i) => close(chunk.positions[i], v));
    assert.deepEqual([...chunk.colors!], [1,0,0,0,1,0,0,0,1]);
    assert.deepEqual([...chunk.intensities!], [123,456,789]);
    assert.deepEqual([...chunk.classifications!], [42,128,255]);
    assert.deepEqual([...chunk.normals!], [1,0,0,0,1,0,0,0,1]);
    assert.equal(progress.at(-1), 3);
  } finally { reader.close(); }
});

it('normal inverse transpose follows nonuniform alignment; classification survives the output', () => {
  const columns = positionedScanColumns({ pointCount: 1, positions: new Float32Array([1,2,3]),
    normals: new Float32Array([1,1,0]), normalState: 'supplied', classifications: new Uint8Array([42]),
    bbox: { min: [1,2,3], max: [1,2,3] } }, [2,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
  close(columns.nx[0], 1 / Math.sqrt(5)); close(columns.ny[0], 2 / Math.sqrt(5));
  assert.equal(columns.classification[0], 42);
});

it('cancellation and read failure always close the separate source and produce no partial blob', async () => {
  const controller = new AbortController();
  const source = new PlyStreamingSource(sourcePly());
  let closed = 0; const original = source.close.bind(source);
  source.close = () => { closed++; original(); };
  await assert.rejects(exportPositionedScan(source, identity, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.ok(closed >= 2); // open closes old state; exporter releases its stream.
  assert.equal(await source.next(1), null, 'closed sources yield no more points');
  const broken = new PlyStreamingSource(new Blob(['not a ply']));
  let released = false; const release = broken.close.bind(broken);
  broken.close = () => { released = true; release(); };
  await assert.rejects(exportPositionedScan(broken, identity, signal(), () => {}));
  assert.equal(released, true);
});

it('PLY refuses non-finite values, changing schemas and empty output', () => {
  const ply = new PositionedPly();
  assert.throws(() => ply.finish(), /no exportable/);
  assert.throws(() => ply.add({ x: new Float64Array([NaN]), y: new Float64Array([0]), z: new Float64Array([0]) }), /Non-finite/);
  ply.add({ x: new Float64Array([1]), y: new Float64Array([2]), z: new Float64Array([3]) });
  assert.throws(() => ply.add({ x: new Float32Array([1]), y: new Float32Array([2]), z: new Float32Array([3]) }), /attributes changed/);
});

it('scan snapshot reverses viewer axes and restores the original decode origin exactly once', () => {
  const model = { ...fixtureModel('scan'), sourceFile: new File([sourcePly()], 'scan.ply'), pointCloudHandleId: 9841 };
  const placement = emptyPlacementState();
  placement.placements = new Map([['scan', { translation: [0.125, -2, 3], rotation: ZERO_ROTATION, locked: false }]]);
  useViewerStore.setState({ ...fixtureModels(model), geometryResult: null, modelPlacement: placement });
  registerPointCloudAlignment({ id: 9841 }, undefined);
  try {
    retargetPointCloudDecodeOrigin({ setPointCloudTransform() {} }, { id: 9841 }, [5000000,10,20]);
    const snapshot = positionedExportSnapshot(useViewerStore.getState(), 'scan');
    assert.equal(snapshot.kind, 'scan');
    assert.deepEqual(snapshot.matrix.slice(12,15), [5000000.125,8,23]);
    assert.deepEqual(snapshot.matrix.slice(0,12).map(v => v || 0), identity.slice(0,12));
  } finally { unregisterPointCloudAlignment(9841); }
});

it('Gaussian PLY reopens in project Z-up without replaying movement or losing source data', async () => {
  const decoded = await decodeGaussianFile(gaussianPly('capture.ply', [[1,2,3], [4,5,6]]));
  const matrix = [...identity]; matrix[12] = 5000000.125; matrix[13] = -2; matrix[14] = 3;
  const ply = new PositionedPly();
  for await (const columns of positionedGaussianChunks(decoded, restoreGaussianOrigin(matrix, decoded.decodeOrigin))) ply.add(columns);
  const reopened = await decodeGaussianFile(new File([ply.finish()], 'positioned.ply'));
  assert.equal(reopened.count, 2);
  assert.deepEqual(reopened.centerBounds, { min: [5000001.125,0,6], max: [5000004.125,3,9] });
  for (const name of ['opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'f_dc_0']) assert.deepEqual(reopened.columns[name], decoded.columns[name]);
});

it('an idle placement session permits export, while an uncommitted movement is refused', () => {
  const model = { ...fixtureModel('scan'), sourceFile: new File([sourcePly()], 'scan.ply'), pointCloudHandleId: 9842 };
  useViewerStore.setState({ ...fixtureModels(model), geometryResult: null, modelPlacement: emptyPlacementState() });
  registerPointCloudAlignment({ id: 9842 }, undefined);
  try {
    useViewerStore.getState().openReposition(['scan']);
    assert.equal(positionedExportSnapshot(useViewerStore.getState(), 'scan').kind, 'scan');
    useViewerStore.getState().previewModelTranslation([1,2,3]);
    assert.throws(()=>positionedExportSnapshot(useViewerStore.getState(), 'scan'), /Apply or cancel/);
    useViewerStore.getState().applyModelTranslation();
    useViewerStore.getState().openReposition(['scan']); // same Apply lifecycle as the runtime host
    assert.deepEqual(positionedExportSnapshot(useViewerStore.getState(), 'scan').matrix.slice(12,15),[1,2,3]);
  } finally { unregisterPointCloudAlignment(9842); }
});

it('whole-file PCD sources are subdivided before transformation and can cancel between batches', async () => {
  const { PcdStreamingSource } = await import('@ifc-lite/pointcloud');
  const blob=new Blob(['VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 9000\nHEIGHT 1\nPOINTS 9000\nDATA ascii\n', '1 2 3\n'.repeat(9000)]);
  const controller=new AbortController(); const progress:number[]=[];
  await assert.rejects(exportPositionedScan(new PcdStreamingSource(blob),identity,controller.signal,n=>{
    progress.push(n);controller.abort();
  }),{name:'AbortError'});
  assert.deepEqual(progress,[8192]);
});

it('preflight rejects compressed PCD expansion before reading/decompressing its payload', async () => {
  const { preflightPositionedScan } = await import('./preflight');
  const blob=new Blob(['VERSION .7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 2000000\nHEIGHT 1\nPOINTS 2000000\nDATA binary_compressed\n']);
  await assert.rejects(preflightPositionedScan(blob,'pcd',signal()), /limit/);
});

it('heterogeneous source chunks use global attribute schema and explicit zero fill', async () => {
  const { decodePly } = await import('@ifc-lite/pointcloud');
  const rows = [
    { positions:new Float32Array([1,2,3]),colors:new Float32Array([1,0,0]),pointCount:1,normalState:'absent' as const,bbox:{min:[1,2,3] as [number,number,number],max:[1,2,3] as [number,number,number]} },
    { positions:new Float32Array([4,5,6]),pointCount:1,normalState:'absent' as const,bbox:{min:[4,5,6] as [number,number,number],max:[4,5,6] as [number,number,number]} },
  ];
  // Stated invariant: a multi-scan source advertises RGB globally, while only
  // one scan supplies it. Output must preserve both points and a stable schema.
  const source = { async open(){return {totalPointCount:2,bbox:rows[0].bbox,hasColor:true,hasIntensity:false,hasClassification:false};},
    async next(){return rows.shift() ?? null;},close(){} };
  const output=decodePly(new Uint8Array(await (await exportPositionedScan(source,identity,signal(),()=>{})).arrayBuffer()));
  assert.equal(output.pointCount,2);assert.deepEqual([...output.colors!],[1,0,0,0,0,0]);
});

it('real plant capture downloads and reopens with placement baked in', async t => {
  const { existsSync, readFileSync } = await import('node:fs');
  const path = new URL('../../../../../../tests/models/gaussian/plant.splat', import.meta.url);
  if (!existsSync(path)) { t.skip('Run pnpm fixtures gaussian/plant.splat'); return; }
  const original=await decodeGaussianFile(new File([readFileSync(path)],'plant.splat'));
  const matrix=[...identity];matrix[12]=12.125;matrix[13]=-7;matrix[14]=3;
  const writer=new PositionedPly();
  for await (const columns of positionedGaussianChunks(original,restoreGaussianOrigin(matrix,original.decodeOrigin))) writer.add(columns);
  const result=await decodeGaussianFile(new File([writer.finish()],'plant-positioned.ply'));
  assert.equal(result.count,original.count);
  for (let axis=0;axis<3;axis++) {
    close(result.centerBounds.min[axis],original.centerBounds.min[axis]+matrix[12+axis]);
    close(result.centerBounds.max[axis],original.centerBounds.max[axis]+matrix[12+axis]);
  }
  assert.deepEqual(result.columns.opacity,original.columns.opacity);
  assert.deepEqual(result.columns.f_dc_0,original.columns.f_dc_0);
});

it('survey control fixture exports its full coordinates and RGB without saved placement', async t => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { AsciiPointsStreamingSource } = await import('@ifc-lite/pointcloud');
  const path = new URL('../../../../../../tests/models/landxml/federation/bonsai-topo-control-v1/survey.xyz', import.meta.url);
  if (!existsSync(path)) { t.skip('Run pnpm fixtures landxml/federation/bonsai-topo-control-v1/survey.xyz'); return; }
  const source = new AsciiPointsStreamingSource(new Blob([readFileSync(path)]),'xyz',{originOffset:[500000,6400000,100]});
  const matrix=[...identity];matrix[12]=500000.125;matrix[13]=6400000.25;matrix[14]=100.5;
  const output=await exportPositionedScan(source,matrix,signal(),()=>{});
  const reader=new PlyStreamingSource(output,{originOffset:[500000,6400000,100]});
  try {
    assert.equal((await reader.open()).totalPointCount,5);
    const points=await reader.next(10);assert.ok(points);
    assert.deepEqual([...points.positions],[0.125,0.25,0.5,20.125,0.25,1.5,0.125,20.25,2.5,20.125,20.25,3.5,10.125,10.25,2]);
    assert.ok(points.colors);assert.equal(points.colors[0],1);
  } finally { reader.close(); }
});

it('aligned and unaligned scan exports remove RTC offsets and keep per-axis alignment scale', async () => {
  const { createCoordinateInfo } = await import('@/utils/localParsingUtils');
  const { applyPointCloudAlignmentToggle, reframeRegisteredPointClouds } = await import('@/hooks/ingest/pointCloudAlignmentRegistry');
  const target={setPointCloudTransform(){}};
  const origin=[500000,6400000,100] as const;
  const bounds={min:{x:0,y:0,z:0},max:{x:1,y:1,z:1}};
  const reference={...fixtureModel('ifc'),loadedAt:1,geometryResult:{meshes:[],totalTriangles:0,totalVertices:0,
    coordinateInfo:{...createCoordinateInfo(bounds),wasmRtcOffset:{x:1000,y:2000,z:3000}}}};
  const model={...fixtureModel('scan'),sourceFile:new File([sourcePly()],'scan.ply'),pointCloudHandleId:9843};
  useViewerStore.setState({...fixtureModels(reference,model),geometryResult:null,modelPlacement:emptyPlacementState()});
  reframeRegisteredPointClouds(target,{x:1000,y:3000,z:-2000});
  registerPointCloudAlignment({id:9843},{decodeOriginOffset:origin,decodeOriginOffsetUnit:'metre',
    alignedMatrix:new Float64Array([2,0,0,0,0,4,0,0,0,0,3,0,-990,-2970,1980,1]),
    unalignedMatrix:new Float64Array([1,0,0,0,0,1,0,0,0,0,1,0,500000,100,-6400000,1])});
  try {
    retargetPointCloudDecodeOrigin(target,{id:9843},origin);
    const chunk={pointCount:1,positions:new Float32Array([1,2,3]),normalState:'absent' as const,bbox:{min:[1,2,3] as [number,number,number],max:[1,2,3] as [number,number,number]}};
    const aligned=positionedScanColumns(chunk,positionedExportSnapshot(useViewerStore.getState(),'scan').matrix);
    assert.deepEqual([aligned.x[0],aligned.y[0],aligned.z[0]],[12,26,42]);
    applyPointCloudAlignmentToggle(target,false);
    const raw=positionedScanColumns(chunk,positionedExportSnapshot(useViewerStore.getState(),'scan').matrix);
    assert.deepEqual([raw.x[0],raw.y[0],raw.z[0]],[500001,6400002,103]);
  } finally { unregisterPointCloudAlignment(9843);reframeRegisteredPointClouds(target,{x:0,y:0,z:0}); }
});

it('compressed LAS and renamed COPC choose a full-resolution LAZ reader by content', async () => {
  const { positionedScanFormat } = await import('./preflight');
  const header=new ArrayBuffer(589);const bytes=new Uint8Array(header);const data=new DataView(header);
  bytes.set(new TextEncoder().encode('LASF'));bytes[104]=0x80|7;
  assert.equal(positionedScanFormat('renamed.las',header),'laz');
  bytes[104]=7;
  assert.equal(positionedScanFormat('raw.laz',header),'las');
  bytes[24]=1;bytes[25]=4;data.setUint16(94,375,true);
  bytes.set(new TextEncoder().encode('copc'),377);data.setUint16(393,1,true);
  assert.equal(positionedScanFormat('renamed.las',header),'laz');
});
