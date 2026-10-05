/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6887: every streamed scan format leaves ingest carrying its federation
 * identity, at `models.size` 1 and N, and keeps it when another model goes.
 *
 * Invariant, per format: the renderer asset (what picking and the deviation
 * readback report) carries the global expressId that `resolveGlobalIdFromModels`
 * maps back to THIS scan's model, and the model index `modelIndices` assigned
 * that model. Before #6887 the asset kept `modelIndex` unset, which the
 * readback reports as 0: the IFC model's index whenever the IFC came first.
 *
 * LAS, PLY, PCD, PTS and XYZ decode real bytes through their streaming
 * sources. LAZ needs laz-perf's wasm and E57 a CRC-paged binary, neither of
 * which this suite can build in node, so those two stream the same seeded
 * points from a stand-in source: the identity is set on the asset before any
 * source is opened and bound after the stream ends, so the decoder cannot
 * change it. COPC is LAZ through `streamPointCloudOrCopc`, which feeds the
 * same asset handle (its LOD path needs the COPC worker; see the PR's e2e).
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AsciiPointsStreamingSource, LasStreamingSource, PcdStreamingSource, PlyStreamingSource,
  type DecodedPointChunk, type StreamingPointSource,
} from '@ifc-lite/pointcloud';
import { useViewerStore } from '@/store';
import { modelIndices } from '@/lib/model-placement/model-indices';
import { addIfcModel, loadScan, readbackIdentities, scanTestRenderer, type ScanLoad } from '@/test/scan-federation';
import { ingestPointCloud, type PointCloudFormat } from './pointCloudIngest.js';
import { bindPointCloudIdentity } from './pointCloudIdentity.js';
import { removePointCloudScanCache } from './pointCloudScanCache.js';
import { unregisterPointCloudAlignment } from './pointCloudAlignment.js';

/** Seeded integer points in [-5, 5]: exact in every format, including LAS at scale 1. */
function seededPoints(seed: number, n: number): Array<[number, number, number]> {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state % 11) - 5; };
  return Array.from({ length: n }, () => [next(), next(), next()] as [number, number, number]);
}

const POINTS = seededPoints(6887, 7);
const text = (s: string) => new Blob([new TextEncoder().encode(s)]);
const rows = (sep = ' ') => POINTS.map((p) => p.join(sep)).join('\n') + '\n';

/** LAS 1.2, point format 0, scale 1, offset 0. */
function lasBlob(): Blob {
  const headerSize = 227, recordLen = 20;
  const view = new DataView(new ArrayBuffer(headerSize + POINTS.length * recordLen));
  view.setUint32(0, 0x4653414c, true);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint16(105, recordLen, true);
  view.setUint32(107, POINTS.length, true);
  for (const at of [131, 139, 147]) view.setFloat64(at, 1, true);
  for (let axis = 0; axis < 3; axis++) {
    view.setFloat64(179 + axis * 16, Math.max(...POINTS.map((p) => p[axis])), true);
    view.setFloat64(187 + axis * 16, Math.min(...POINTS.map((p) => p[axis])), true);
  }
  POINTS.forEach((p, i) => p.forEach((v, axis) => view.setInt32(headerSize + i * recordLen + axis * 4, v, true)));
  return new Blob([view.buffer]);
}

/** Serves `POINTS` as one chunk; stands in for a decoder node cannot run here. */
class SeededSource implements StreamingPointSource {
  private served = false;
  async open() {
    const bbox = { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
    return { totalPointCount: POINTS.length, bbox, hasColor: false, hasClassification: false, hasIntensity: false };
  }
  async next(): Promise<DecodedPointChunk | null> {
    if (this.served) return null;
    this.served = true;
    const positions = Float32Array.from(POINTS.flat());
    return { positions, pointCount: POINTS.length, normalState: 'absent', bbox: { min: [-5, -5, -5], max: [5, 5, 5] } };
  }
  close() {}
}

type Opts = { stride?: number; originOffset?: readonly [number, number, number] };
const hint = (o: Opts) => ({ downsample: { stride: o.stride ?? 1 }, originOffset: o.originOffset });

/** One scan per streamed format; the union `ingestPointCloud` accepts, exhaustively. */
const SCANS: Record<PointCloudFormat, () => ScanLoad> = {
  las: () => ({ format: 'las', blob: lasBlob(), createSource: (o) => new LasStreamingSource(o.blob, hint(o)) }),
  laz: () => ({ format: 'laz', blob: lasBlob(), createSource: () => new SeededSource() }),
  e57: () => ({ format: 'e57', blob: text('ASTM-E57'), createSource: () => new SeededSource() }),
  ply: () => ({
    format: 'ply',
    blob: text(`ply\nformat ascii 1.0\nelement vertex ${POINTS.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n${rows()}`),
    createSource: (o) => new PlyStreamingSource(o.blob, hint(o)),
  }),
  pcd: () => ({
    format: 'pcd',
    blob: text(`VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${POINTS.length}\nHEIGHT 1\nPOINTS ${POINTS.length}\nDATA ascii\n${rows()}`),
    createSource: (o) => new PcdStreamingSource(o.blob, hint(o)),
  }),
  pts: () => ({ format: 'pts', blob: text(`${POINTS.length}\n${rows()}`), createSource: (o) => new AsciiPointsStreamingSource(o.blob, 'pts', hint(o)) }),
  xyz: () => ({ format: 'xyz', blob: text(rows()), createSource: (o) => new AsciiPointsStreamingSource(o.blob, 'xyz', hint(o)) }),
};

const handles: number[] = [];
afterEach(() => {
  for (const id of handles.splice(0)) { removePointCloudScanCache(id); unregisterPointCloudAlignment(id); }
  useViewerStore.getState().clearAllModels();
  modelIndices(new Map());
});

/** What a pick or a deviation readback would report for `scanId`, and whether it resolves back to it. */
function assertBound(points: ReturnType<typeof scanTestRenderer>['points'], scanId: string) {
  const state = useViewerStore.getState();
  const scan = state.models.get(scanId)!;
  const [asset, ...others] = readbackIdentities(points).filter((a) => state.resolveGlobalIdFromModels(a.expressId)?.modelId === scanId);
  assert.ok(asset, `${scanId}: a renderer asset resolves to its model`);
  assert.equal(others.length, 0);
  assert.equal(asset.modelIndex, modelIndices(state.models).get(scanId), `${scanId}: the asset reports its model's index`);
  const ref = state.resolveGlobalIdFromModels(asset.expressId)!;
  assert.equal(scan.ifcDataStore?.entities.getGlobalId(ref.expressId), `pointcloud-${ref.expressId}`);
  assert.equal(scan.ifcDataStore?.entities.getTypeName(ref.expressId), 'IfcGeographicElement');
  assert.equal(points.getPickNodes().find((n) => n.expressId === asset.expressId)?.modelIndex, asset.modelIndex);
  return asset;
}

describe('streamed scan identity after ingest (#6887)', () => {
  for (const format of Object.keys(SCANS) as PointCloudFormat[]) {
    it(`${format}: federated after an IFC model, the asset is model 1, not the readback default 0`, async () => {
      const { renderer, points } = scanTestRenderer();
      addIfcModel('ifc', [{ expressId: 1, type: 'IfcWall', globalId: '2O2Fr$t4X7Zf8NOew3FLOH' }, { expressId: 40, type: 'IfcSlab' }]);
      const { handle } = await loadScan(renderer, 'scan', SCANS[format]());
      handles.push(handle.id);
      assert.equal(points.getPointCount(), POINTS.length, 'the scan streamed every point');
      const asset = assertBound(points, 'scan');
      assert.equal(asset.modelIndex, 1);
      assert.ok(asset.expressId > 40, 'the scan id is past the IFC model range');
    });

    it(`${format}: alone (models.size 1) it is model 0 and keeps that when an IFC model joins`, async () => {
      const { renderer, points } = scanTestRenderer();
      const { handle } = await loadScan(renderer, 'scan', SCANS[format]());
      handles.push(handle.id);
      assert.equal(useViewerStore.getState().models.size, 1);
      const alone = assertBound(points, 'scan');
      assert.equal(alone.modelIndex, 0);
      addIfcModel('ifc', [{ expressId: 1, type: 'IfcWall' }]);
      assert.deepEqual(assertBound(points, 'scan'), alone);
    });
  }

  it('a superseded stream is never bound to the identity of a model that owns another handle', async () => {
    const { renderer, points } = scanTestRenderer();
    addIfcModel('ifc', [{ expressId: 1, type: 'IfcWall' }]);
    // A stream whose load was superseded: opened on the same renderer, never registered.
    const stale = ingestPointCloud({ format: 'las', blob: lasBlob(), fileName: 'stale.las', fileSize: 1, renderer,
      createSource: (o) => new LasStreamingSource(o.blob, hint(o)) });
    await stale.done;
    handles.push(stale.rendererHandle.id);
    // The live load registered under the same model id with its own handle.
    const { handle } = await loadScan(renderer, 'scan', SCANS.las());
    handles.push(handle.id);
    const live = assertBound(points, 'scan');
    const staleBefore = readbackIdentities(points).find((a) => a.expressId !== live.expressId);
    assert.ok(staleBefore, 'the stale stream is still resident');
    bindPointCloudIdentity(renderer, stale.rendererHandle, 'scan', useViewerStore.getState().models);
    assert.deepEqual(assertBound(points, 'scan'), live, 'only the owning handle carries the scan identity');
    assert.ok(readbackIdentities(points).some((a) => a.expressId === staleBefore.expressId && a.modelIndex === staleBefore.modelIndex));
  });

  it('removing an earlier model shifts neither the scan id nor its index', async () => {
    const { renderer, points } = scanTestRenderer();
    addIfcModel('a', [{ expressId: 1, type: 'IfcWall' }, { expressId: 9, type: 'IfcDoor' }]);
    addIfcModel('b', [{ expressId: 1, type: 'IfcSlab' }]);
    const { handle } = await loadScan(renderer, 'scan', SCANS.las());
    handles.push(handle.id);
    const before = assertBound(points, 'scan');
    assert.equal(before.modelIndex, 2);
    useViewerStore.getState().removeModel('a');
    assert.deepEqual(assertBound(points, 'scan'), before);
    // A model added after the removal takes a fresh index, never the scan's.
    addIfcModel('c', [{ expressId: 1, type: 'IfcBeam' }]);
    assert.deepEqual(assertBound(points, 'scan'), before);
    assert.notEqual(modelIndices(useViewerStore.getState().models).get('c'), before.modelIndex);
  });
});
