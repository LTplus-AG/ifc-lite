/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The detection overlay (#6894) on a real detection of the seeded room: it
 * draws exactly the detections behind the visible proposals, in the render
 * frame the point cloud is drawn in, coloured by class; and a run ends with
 * the scan or target model it belongs to.
 */

import '@/test/setup-dom.js';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { scanRoomSample } from '@/test/scan-room-fixture';
import { useViewerStore } from '@/store';
import { viewerTeardown } from '@/store/teardown-registry';
import { SCAN_PROPOSAL_CLASSES, type ScanDetectionRun } from '@/store/slices/scanDetectionSlice';
import { nativePointCloudOriginMatrix } from '@/hooks/ingest/pointCloudDecodeOrigin';
import { runScanDetectJob } from './detect-job';
import { ACCEPTED_ALPHA, detectionOverlayMeshes, PENDING_ALPHA, SCAN_OVERLAY_MODEL_INDEX, SCAN_PROPOSAL_COLORS } from './detection-overlay';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const all = { classes: SCAN_PROPOSAL_CLASSES, minConfidence: 0 };

function run(cloudMatrix: number[] | null): ScanDetectionRun {
  const positions = scanRoomSample();
  const result = runScanDetectJob({ positions, count: positions.length / 3, region: null, scanToModel: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1], schema: 'IFC4' });
  return { sourceModelId: 'scan', targetModelId: 'ifc', cropped: false, pointCount: positions.length / 3, cloudMatrix, result };
}

const triangles = (meshes: ReturnType<typeof detectionOverlayMeshes>) => meshes.reduce((n, m) => n + m.indices.length / 3, 0);

describe('detection overlay (#6894)', () => {
  it('draws each class in its colour: a quad per plane, a 16-sided tube per cylinder', (t) => {
    if (!ensureWasm(t)) return;
    const r = run(IDENTITY);
    const meshes = detectionOverlayMeshes(r, {}, all, (i) => 900 + i);
    assert.deepEqual(meshes.map((m) => m.expressId), [900, 901, 902]);
    const byColor = (cls: 'IfcWall' | 'IfcSlab' | 'IfcColumn') => meshes.find((m) => m.color.slice(0, 3).join() === SCAN_PROPOSAL_COLORS[cls].join())!;
    assert.equal(byColor('IfcWall').indices.length / 3, 4 * 2, 'four wall faces');
    assert.equal(byColor('IfcSlab').indices.length / 3, 2 * 2, 'floor and ceiling');
    assert.equal(byColor('IfcColumn').indices.length / 3, 16 * 2, 'one tube');
    assert.ok(meshes.every((m) => m.color[3] === PENDING_ALPHA));
  });

  it('maps detections through the point cloud matrix into the render frame', (t) => {
    if (!ensureWasm(t)) return;
    const shifted = [...IDENTITY.slice(0, 12), 100, 20, -30, 1];
    const a = detectionOverlayMeshes(run(IDENTITY), {}, all, (i) => i);
    const b = detectionOverlayMeshes(run(shifted), {}, all, (i) => i);
    // The drawn point is `origin + position` (the batcher folds it in float64).
    const world = (mesh: (typeof b)[number], i: number) => (mesh.origin?.[i % 3] ?? 0) + mesh.positions[i];
    for (let m = 0; m < a.length; m++) {
      for (let i = 0; i < a[m].positions.length; i += 3) {
        assert.ok(Math.abs(world(b[m], i) - world(a[m], i) - 100) < 1e-3);
        assert.ok(Math.abs(world(b[m], i + 1) - world(a[m], i + 1) - 20) < 1e-3);
        assert.ok(Math.abs(world(b[m], i + 2) - world(a[m], i + 2) + 30) < 1e-3);
      }
    }
  });

  it('leaves out rejected and filtered-out proposals and draws accepted ones opaque', (t) => {
    if (!ensureWasm(t)) return;
    const r = run(null);
    const walls = r.result.proposals.proposals.filter((p) => p.ifcClass === 'IfcWall');
    const decided = { [walls[0].id]: 'rejected' as const, [walls[1].id]: 'accepted' as const };
    const meshes = detectionOverlayMeshes(r, decided, all, (i) => i);
    assert.equal(triangles(meshes), triangles(detectionOverlayMeshes(r, {}, all, (i) => i)) - 2);
    assert.equal(meshes.filter((m) => m.color[3] === ACCEPTED_ALPHA).reduce((n, m) => n + m.indices.length / 3, 0), 2);
    const columnsOnly = detectionOverlayMeshes(r, {}, { classes: ['IfcColumn'], minConfidence: 0 }, (i) => i);
    assert.equal(triangles(columnsOnly), 32);
    assert.equal(detectionOverlayMeshes(r, {}, { ...all, minConfidence: 1.01 }, (i) => i).length, 0);
    assert.deepEqual(detectionOverlayMeshes(null, {}, all, (i) => i), []);
  });

  it('a run ends when its scan or target model is removed, and survives other removals', (t) => {
    if (!ensureWasm(t)) return;
    const r = run(null);
    const state = { ...useViewerStore.getState(), scanDetectionRun: r, scanDetectionStatus: 'done' as const };
    const removed = (modelId: string) => viewerTeardown({ kind: 'model-removed', modelId, isStale: () => false, nextActiveModelId: null }, state);
    assert.equal(removed('scan').scanDetectionRun, null);
    assert.equal(removed('ifc').scanDetectionRun, null);
    assert.equal('scanDetectionRun' in removed('other'), false);
  });
});

describe('detection overlay at map-grid origins (#6894)', () => {
  // A georeferenced scan at its native origin beside a blank model: the overlay's render-frame
  // coordinates are ~1e6 m. Float32 vertices there step 0.125-0.5 m, so each mesh carries a
  // float64 `origin` and small relative positions; the batcher folds origin + position in f64.
  for (const [name, origin] of [['LV95', [2_600_000.37, 1_200_000.83, 410.21]], ['UTM', [500_000.37, 5_300_000.83, 300.21]]] as const) {
    it(`${name}: every drawn vertex (origin + position) is the float64 point within 1 mm`, (t) => {
      if (!ensureWasm(t)) return;
      const placed = Array.from(nativePointCloudOriginMatrix(origin));
      const near = run(IDENTITY), far = { ...run(IDENTITY), cloudMatrix: placed };
      const reference = detectionOverlayMeshes(near, {}, all, (i) => i);
      const drawn = detectionOverlayMeshes(far, {}, all, (i) => i);
      assert.equal(drawn.length, reference.length);
      const t3 = [placed[12], placed[13], placed[14]];
      let worst = 0;
      for (const [m, mesh] of drawn.entries()) {
        const o = mesh.origin ?? [0, 0, 0];
        const ref = reference[m].positions;
        for (let i = 0; i < mesh.positions.length; i++) {
          worst = Math.max(worst, Math.abs(o[i % 3] + mesh.positions[i] - (ref[i] + t3[i % 3])));
        }
      }
      assert.ok(worst < 1e-3, `worst vertex error ${worst} m`);
      // Batched as its own model: never in a model's shared GPU frame (see the renderer's scene-far-frame-6894 test).
      assert.ok(drawn.every((mesh) => mesh.modelIndex === SCAN_OVERLAY_MODEL_INDEX));
    });
  }
});
