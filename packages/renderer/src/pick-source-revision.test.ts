/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `Renderer.getPickGeometryRevision()` also counts the pick sources outside
 * the Scene that the magnetic pick snaps to: point clouds (#9029) and the
 * source snap curves a selection installs (#9030). The viewer's Measure
 * Point "Live" reading compares that one revision (#8998).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from './index.js';
import { PointCloudRenderer } from './pointcloud/point-cloud-renderer.js';
import type { SourceSnapCurve } from './source-curve-snap.js';

(globalThis as Record<string, unknown>).GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2 };
(globalThis as Record<string, unknown>).GPUBufferUsage ??= {
  COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128,
};

function pointDevice(): GPUDevice {
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 }, createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}), createShaderModule: () => ({}), createRenderPipeline: () => ({}), createBindGroup: () => ({}),
    createBuffer: ({ size }: GPUBufferDescriptor) => ({ size, destroy() {} }), queue: { writeBuffer() {} },
  } as unknown as GPUDevice;
}

const chunk = (x: number) => ({ pointCount: 1, positions: new Float32Array([x, 0, 0]), classifications: new Uint8Array([2]),
  bbox: { min: [x, 0, 0] as [number, number, number], max: [x, 0, 0] as [number, number, number] } });

/** A renderer holding a real point renderer with one streamed scan (one COPC node) and one embedded cloud. */
function setup() {
  const renderer = new Renderer({ width: 256, height: 256,
    getBoundingClientRect: () => ({ width: 256, height: 256 }) } as unknown as HTMLCanvasElement);
  const points = new PointCloudRenderer(pointDevice(), 'rgba8unorm', 'depth32float', 1);
  (renderer as unknown as { pointCloudRenderer: PointCloudRenderer }).pointCloudRenderer = points;
  renderer.addPointClouds([{ expressId: 1, modelIndex: 0, chunk: chunk(1) }]);
  const scan = renderer.beginPointCloudStream({ expressId: 2, modelIndex: 1 });
  renderer.appendPointCloudChunk(scan, chunk(2), 'node-0');
  /** Run `change`, and say whether the revision moved. */
  const bumps = (change: () => unknown): boolean => {
    const before = renderer.getPickGeometryRevision();
    change();
    return renderer.getPickGeometryRevision() !== before;
  };
  return { renderer, points, scan, bumps };
}

const ALL_CLASSES = new Uint32Array(8).fill(0xffffffff);

describe('point clouds in the pick-geometry revision (#9029)', () => {
  it('changes on every change to the points a snap can hit', () => {
    const changes: Array<[string, (s: ReturnType<typeof setup>) => unknown]> = [
      ['a COPC node lands after the camera stops', ({ renderer, scan }) => renderer.appendPointCloudChunk(scan, chunk(3), 'node-1')],
      ['a COPC node is evicted', ({ renderer, scan }) => renderer.removePointCloudChunk(scan, 'node-0')],
      ['a scan is unloaded', ({ renderer, scan }) => renderer.removePointCloudAsset(scan)],
      ['an embedded cloud is added', ({ renderer }) => renderer.addPointClouds([{ expressId: 3, chunk: chunk(4) }])],
      ['the embedded clouds are replaced', ({ renderer }) => renderer.setPointClouds([{ expressId: 3, chunk: chunk(4) }])],
      ['every cloud is cleared', ({ renderer }) => renderer.clearPointClouds()],
      ['a class is filtered out', ({ renderer }) => renderer.setPointCloudOptions({ classMask: [~(1 << 2) >>> 0, -1, -1, -1, -1, -1, -1, -1] })],
      ['a scan is hidden', ({ renderer, scan }) => renderer.setPointCloudVisibility(scan, false)],
      ['a scan is moved', ({ renderer, scan }) => renderer.setPointCloudTranslation(scan, [5, 0, 0])],
      ['a scan is aligned', ({ renderer, scan }) => renderer.setPointCloudTransform(scan, new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 0, 0, 1]))],
      ['a scan is relabelled', ({ renderer, scan }) => renderer.relabelPointCloudAsset(scan, 77, 2)],
    ];
    for (const [name, change] of changes) {
      const s = setup();
      assert.equal(s.bumps(() => change(s)), true, `the revision missed: ${name}`);
    }
  });

  it('a re-pushed embedded list counts only when it differs from what setPointClouds installed', () => {
    const { renderer, bumps } = setup();
    const list = [{ expressId: 3, modelIndex: 2, chunk: chunk(4) }];
    renderer.setPointClouds(list);
    assert.equal(bumps(() => renderer.setPointClouds(list.map((asset) => ({ ...asset })))), false,
      'the same assets, re-stamped into fresh objects by the merge');
    assert.equal(bumps(() => renderer.setPointClouds([{ ...list[0], modelIndex: 5 }])), true, 'a different model index');
    renderer.setPointClouds(list);
    renderer.addPointClouds([{ expressId: 9, chunk: chunk(9) }]);
    assert.equal(bumps(() => renderer.setPointClouds(list)), true, 'the same list dropping a cloud addPointClouds added');
    renderer.clearPointClouds();
    assert.equal(bumps(() => renderer.setPointClouds([])), false, 'no embedded clouds, before or after');
    assert.equal(bumps(() => renderer.setPointClouds(list)), true, 'the list back after a clear');
  });

  it('a replacement that fails partway counts, and so does the retry of the same list', () => {
    const { renderer, points, bumps } = setup();
    const list = [{ expressId: 3, chunk: chunk(4) }];
    renderer.setPointClouds(list);
    const upload = points.addAsset;
    points.addAsset = () => { throw new Error('out of memory'); };
    assert.equal(bumps(() => assert.throws(() => renderer.setPointClouds(list))), true, 'the old clouds were dropped');
    points.addAsset = upload;
    assert.equal(bumps(() => renderer.setPointClouds(list)), true, 'the retry rebuilt them');
  });

  it('an add or a COPC node that fails partway still counts', () => {
    const { renderer, points, scan, bumps } = setup();
    const upload = points.addAsset.bind(points);
    let uploads = 0;
    points.addAsset = (asset) => { if (++uploads > 1) throw new Error('out of memory'); return upload(asset); };
    assert.equal(bumps(() => assert.throws(() => renderer.addPointClouds([{ expressId: 5, chunk: chunk(5) }, { expressId: 6, chunk: chunk(6) }]))), true,
      'the first cloud became pickable before the second threw');
    points.appendChunk = () => { throw new Error('out of memory'); };
    assert.equal(bumps(() => assert.throws(() => renderer.appendPointCloudChunk(scan, chunk(7), 'node-2'))), true);
  });

  it('zero-point descriptors in the list are not embedded clouds', () => {
    const { renderer, bumps } = setup();
    const cloud = { expressId: 3, chunk: chunk(4) };
    const descriptor = { expressId: 2, modelIndex: 1, chunk: { pointCount: 0, positions: new Float32Array(0),
      bbox: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] } } };
    renderer.setPointClouds([cloud, descriptor]);
    assert.equal(bumps(() => renderer.setPointClouds([cloud, { ...descriptor, modelIndex: 4 }])), false, 'a re-stamped descriptor');
    assert.equal(bumps(() => renderer.setPointClouds([cloud])), false, 'a descriptor dropping out');
  });

  it('a list changed in place after setPointClouds still counts', () => {
    const { renderer, bumps } = setup();
    const list = [{ expressId: 3, chunk: chunk(4) }];
    renderer.setPointClouds(list);
    list[0].expressId = 1_000_003; // a federation offset applied to the same object
    assert.equal(bumps(() => renderer.setPointClouds(list)), true);
  });

  it('a hidden scan shown again counts too', () => {
    const { renderer, scan, bumps } = setup();
    renderer.setPointCloudVisibility(scan, false);
    assert.equal(bumps(() => renderer.setPointCloudVisibility(scan, true)), true);
  });

  it('keeps still for work that leaves the snappable points alone', () => {
    const { renderer, scan, bumps } = setup();
    renderer.setPointCloudOptions({ classMask: ALL_CLASSES });
    renderer.setPointCloudTranslation(scan, [1, 0, 0]); // the placement sync's first push
    renderer.setPointCloudTransform(scan, null);
    const still: Array<[string, () => unknown]> = [
      ['a colour, size or stride change', () => renderer.setPointCloudOptions({ colorMode: 'height', pointSize: 9, previewStride: 4, classMask: ALL_CLASSES })],
      ['the class mask it already has, as a fresh array', () => renderer.setPointCloudOptions({ classMask: [-1, -1, -1, -1, -1, -1, -1, -1] })],
      ['the visibility it already has', () => renderer.setPointCloudVisibility(scan, true)],
      ['a stream that opens empty', () => renderer.beginPointCloudStream({ expressId: 4 })],
      ['an eviction of a node it never loaded', () => renderer.removePointCloudChunk(scan, 'never-loaded')],
      ['a stream ending', () => renderer.endPointCloudStream(scan)],
      ['the translation it already has', () => renderer.setPointCloudTranslation(scan, [1, 0, 0])],
      ['the alignment it already has', () => renderer.setPointCloudTransform(scan, null)],
      ['a pick', () => renderer.raycastScene(128, 128)],
    ];
    for (const [name, change] of still) assert.equal(bumps(change), false, `the revision churned on: ${name}`);
  });
});

const curve = (expressId: number, x = 0): SourceSnapCurve => ({
  identity: { modelId: 'm', expressId, solidId: 50, directrixId: 51, mappingPath: [], occurrenceIndex: 0, segmentIndex: 0 },
  globalId: expressId, kind: 'line', length: 1,
  bounds: { center: { x: x + 0.5, y: 0, z: 0 }, radius: 0.5 },
  pointAt: (t) => ({ x: x + t, y: 0, z: 0 }),
});

describe('source snap curves in the pick-geometry revision (#9030)', () => {
  it('changes when a different curve set is installed, or the set is removed', () => {
    const { renderer, bumps } = setup();
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(7)])), true, 'installing a set');
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(7), curve(8)])), true, 'adding a curve');
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(8)])), true, 'swapping to another element');
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(8, 3)])), true, 'the same curve evaluating elsewhere');
    assert.equal(bumps(() => renderer.setSourceSnapCurves([])), true, 'removing the set');
  });

  it('keeps still when the same set is re-installed, as new objects or after a clear no read saw', () => {
    const { renderer, bumps } = setup();
    renderer.setSourceSnapCurves([curve(7)]);
    renderer.getPickGeometryRevision();
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(7)])), false, 'the same set as fresh objects');
    // The overlay clears the channel before paint on every selection change, then re-installs.
    assert.equal(bumps(() => { renderer.setSourceSnapCurves([]); renderer.setSourceSnapCurves([curve(7)]); }), false,
      'a clear and re-install of the same set between reads');
    assert.equal(bumps(() => renderer.setSourceSnapCurves([curve(7)])), false, 'the very same set again');
  });

  it('keeps still for a selection that installs no curves', () => {
    const { renderer, bumps } = setup();
    assert.equal(bumps(() => renderer.setSourceSnapCurves([])), false);
  });
});
