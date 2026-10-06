/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `useScanDetectionOverlay` mounted (#6894): the `scan` overlay channel
 * follows the review (a decision or the filter redraws it, a run ending
 * empties it) and is cleared when the hook unmounts.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { MeshData } from '@ifc-lite/geometry';
import { useViewerStore } from '@/store';
import { render, advance, cleanup } from '@/test/render';
import { ensureWasm } from '@/test/scan-slab-fixture';
import { scanRoomSample } from '@/test/scan-room-fixture';
import { runScanDetectJob } from '@/lib/scan-to-bim/detect-job';
import { ScanDetectionOverlay, useScanDetectionOverlay } from './useScanDetectionOverlay';

function Probe() {
  useScanDetectionOverlay();
  return null;
}

const initial = useViewerStore.getState();
const SWAP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

function seed(t: TestContext) {
  if (!ensureWasm(t)) return null;
  const positions = scanRoomSample();
  const result = runScanDetectJob({ positions, count: positions.length / 3, region: null, scanToModel: SWAP, schema: 'IFC4' });
  const scanMeshes: MeshData[][] = [];
  let cleared = 0;
  const state = useViewerStore.getState();
  useViewerStore.setState({
    cameraCallbacks: {
      ...state.cameraCallbacks,
      setAuthoringOverlayMeshes: (channel, meshes) => { if (channel === 'scan') scanMeshes.push(meshes); },
      clearAuthoringOverlayMeshes: (channel) => { if (channel === 'scan') cleared++; },
    },
  });
  useViewerStore.getState().finishScanDetection({
    sourceModelId: 'scan', targetModelId: null, cropped: false, pointCount: positions.length / 3, cloudMatrix: null, result,
  });
  const triangles = () => (scanMeshes.at(-1) ?? []).reduce((n, m) => n + m.indices.length / 3, 0);
  return { result, scanMeshes, triangles, cleared: () => cleared };
}

afterEach(() => {
  cleanup();
  useViewerStore.setState(initial, true);
});

describe('useScanDetectionOverlay (#6894)', () => {
  it('draws the run on the scan channel and redraws on a decision, the filter and the run ending', async (t) => {
    const s = seed(t);
    if (!s) return;
    render(<Probe />);
    await advance(10);
    const all = s.triangles();
    assert.equal(all, 4 * 2 + 2 * 2 + 16 * 2, 'four wall quads, two slab quads, one tube');
    const wall = s.result.proposals.proposals.find((p) => p.ifcClass === 'IfcWall')!;
    useViewerStore.getState().decideScanProposals([wall.id], 'rejected');
    await advance(10);
    assert.equal(s.triangles(), all - 2, 'a rejected wall is no longer drawn');
    useViewerStore.getState().setScanProposalFilter({ classes: ['IfcColumn'] });
    await advance(10);
    assert.equal(s.triangles(), 16 * 2, 'only the column passes the filter');
    useViewerStore.getState().clearScanDetection();
    await advance(10);
    assert.equal(s.triangles(), 0, 'a run that ends leaves nothing on the channel');
  });

  it('clears the channel before each redraw, so a new run is framed afresh by the renderer', async (t) => {
    const s = seed(t);
    if (!s) return;
    render(<Probe />);
    await advance(10);
    // Every upload follows a clear: the renderer forgets a model's frame once its
    // batches are gone, so a run far from the last one is not drawn in its frame.
    assert.equal(s.cleared(), s.scanMeshes.length, 'one clear per upload');
    const wall = s.result.proposals.proposals.find((p) => p.ifcClass === 'IfcWall')!;
    useViewerStore.getState().decideScanProposals([wall.id], 'rejected');
    await advance(10);
    assert.equal(s.cleared(), s.scanMeshes.length);
  });

  it('mounts lazily: the viewport renders the overlay host only while a run exists', async (t) => {
    const s = seed(t);
    if (!s) return;
    render(<ScanDetectionOverlay />);
    await advance(10);
    assert.ok(s.triangles() > 0);
  });

  it('clears the scan channel when it unmounts', async (t) => {
    const s = seed(t);
    if (!s) return;
    render(<Probe />);
    await advance(10);
    assert.ok(s.triangles() > 0);
    const before = s.cleared();
    cleanup();
    assert.equal(s.cleared(), before + 1, 'unmounting clears the overlay');
  });
});
