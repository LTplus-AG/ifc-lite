/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scan layer's vector outline through the worker tracer (#6884 review):
 * a trace that is still in the worker when the scan disappears must not put
 * its rings (or its dots) back afterwards, and points the scan cache rewrote
 * in place reach the worker. The worker is a stand-in that structured-clones
 * like `postMessage` and runs the real worker body on the real wasm engine,
 * slowly, as a busy thread would.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '@ifc-lite/renderer';
import { useState } from 'react';
import { act } from 'react';
import { render, cleanup, advance } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { ensureWasm, roomSlab } from '@/test/scan-slab-fixture';
import { useViewerStore } from '@/store';
import { resolveSources, type ScanOutlinePoints, type ScanOutlineWorkerRequest } from '@/workers/scanOutline.worker';
import { runScanOutlineJob } from '@/lib/scan-outline/scan-outline-job';
import { setGlobalRendererRef } from './useBCF';
import { registerPointCloudScanCache, addPointsToScanCache, clearAllPointCloudScanCaches, getPointCloudScanSample } from './ingest/pointCloudScanCache';
import { useScanSectionLayer, type UseScanSectionLayerResult } from './useScanSectionLayer';

const WORKER_DELAY_MS = 300;

class SlowWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private terminated = false;
  private cache = new Map<number, ScanOutlinePoints>();
  postMessage(message: ScanOutlineWorkerRequest): void {
    const request = structuredClone(message);
    setTimeout(() => {
      if (this.terminated) return;
      const layer = runScanOutlineJob({ ...request.job, sources: resolveSources(request.sources, this.cache) });
      this.onmessage?.({ data: { type: 'complete', id: request.id, layer } } as MessageEvent);
    }, WORKER_DELAY_MS);
  }
  terminate(): void {
    this.terminated = true;
  }
}

/** The room slab as Y-up scan positions on the plane y = 1. */
function slabPositions(dx = 0): Float32Array {
  const xy = roomSlab();
  const positions = new Float32Array((xy.length / 2) * 3);
  for (let i = 0; i < xy.length / 2; i++) {
    positions[i * 3] = xy[i * 2] + dx;
    positions[i * 3 + 1] = 1;
    positions[i * 3 + 2] = -xy[i * 2 + 1];
  }
  return positions;
}

let latest: UseScanSectionLayerResult | null = null;
let setThickness: (t: number) => void = () => {};
const bounds = { min: { x: 0, y: 0, z: -40 }, max: { x: 80, y: 2, z: 0 } };
function Scan({ initial }: { initial: number }) {
  const models = useViewerStore((s) => s.models);
  const [thickness, set] = useState(initial);
  setThickness = set;
  latest = useScanSectionLayer({
    enabled: true, thickness,
    sectionPlane: { axis: 'down', position: 50, flipped: false },
    coordinateInfo: { originalBounds: bounds, shiftedBounds: bounds, originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false },
    models, legacyPointClouds: undefined,
    outline: { enabled: true, maxGap: 0.3 },
  });
  return null;
}

function setup(t: TestContext): boolean {
  if (!ensureWasm(t)) return false;
  const previous = (globalThis as { Worker?: unknown }).Worker;
  (globalThis as { Worker?: unknown }).Worker = SlowWorker;
  t.after(() => { (globalThis as { Worker?: unknown }).Worker = previous; });
  const renderer = new Renderer(document.createElement('canvas'));
  renderer.getPointCloudTransform = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  setGlobalRendererRef({ current: renderer });
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('scan'), pointCloudHandleId: 7 }), pointCloudAlignmentEnabled: false });
  return true;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await advance(20);
  assert.ok(done(), 'condition reached');
}

afterEach(() => { cleanup(); clearAllPointCloudScanCaches(); setGlobalRendererRef({ current: null }); latest = null; });

describe('useScanSectionLayer vector outline (#6884 review)', () => {
  it('a trace still in the worker when the scan is removed does not bring its rings back', async (t) => {
    if (!setup(t)) return;
    const positions = slabPositions();
    registerPointCloudScanCache(7, positions.length / 3);
    addPointsToScanCache(7, { positions, normalState: 'absent', pointCount: positions.length / 3 });
    render(<Scan initial={0.2} />);
    await until(() => (latest?.outline?.rings.length ?? 0) > 0);
    // A band change starts a trace; the scan goes away while it runs.
    act(() => setThickness(0.3));
    await advance(150);
    useViewerStore.setState({ models: new Map() });
    await advance(WORKER_DELAY_MS * 2);
    assert.equal(latest?.outline, null, 'no rings for a scan that is gone');
    assert.equal(latest?.totalInBand, 0, 'no dots either');
  });

  it('points the scan cache rewrote in place reach the worker', async (t) => {
    if (!setup(t)) return;
    const n = roomSlab().length / 2;
    registerPointCloudScanCache(7, n);
    addPointsToScanCache(7, { positions: slabPositions(), normalState: 'absent', pointCount: n });
    render(<Scan initial={0.2} />);
    await until(() => (latest?.outline?.rings.length ?? 0) > 0);
    // The reservoir is full: further points overwrite slots of the same array.
    addPointsToScanCache(7, { positions: slabPositions(8), normalState: 'absent', pointCount: n });
    assert.equal(getPointCloudScanSample(7)!.count, n, 'same count: slots were overwritten, not appended');
    const before = latest?.outline?.rings;
    act(() => setThickness(0.3));
    await until(() => latest?.outline != null && latest.outline.rings !== before);
    const xs = latest!.outline!.rings.flat().map((p) => p.x);
    assert.ok(Math.max(...xs) > 30, `the rewritten points (a second room 8 m along) are traced; max x ${Math.max(...xs)}`);
  });
});
