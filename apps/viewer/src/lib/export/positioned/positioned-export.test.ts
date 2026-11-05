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
  await assert.rejects(source.next(1), /open/i);
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
