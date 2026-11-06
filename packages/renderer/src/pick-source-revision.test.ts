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
  return { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28 }, createBindGroupLayout: () => ({}),
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

  it('a hidden scan shown again counts too', () => {
    const { renderer, scan, bumps } = setup();
    renderer.setPointCloudVisibility(scan, false);
    assert.equal(bumps(() => renderer.setPointCloudVisibility(scan, true)), true);
  });

  it('keeps still for work that leaves the snappable points alone', () => {
    const { renderer, scan, bumps } = setup();
    renderer.setPointCloudOptions({ classMask: ALL_CLASSES });
    const still: Array<[string, () => unknown]> = [
      ['a colour, size or stride change', () => renderer.setPointCloudOptions({ colorMode: 'height', pointSize: 9, previewStride: 4, classMask: ALL_CLASSES })],
      ['the class mask it already has, as a fresh array', () => renderer.setPointCloudOptions({ classMask: [-1, -1, -1, -1, -1, -1, -1, -1] })],
      ['the visibility it already has', () => renderer.setPointCloudVisibility(scan, true)],
      ['a stream that opens empty', () => renderer.beginPointCloudStream({ expressId: 4 })],
      ['an eviction of a node it never loaded', () => renderer.removePointCloudChunk(scan, 'never-loaded')],
      ['a stream ending', () => renderer.endPointCloudStream(scan)],
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
