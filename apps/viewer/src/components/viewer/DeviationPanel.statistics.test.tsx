/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { DeviationDistances, Renderer } from '@ifc-lite/renderer';
import { cleanup, click, render, type, waitFor } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { DeviationPanel } from './DeviationPanel.js';

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  useViewerStore.getState().setPointCloudColorMode('rgb');
  useViewerStore.getState().setPointCloudDeviationHalfRange(0.05);
});

/** |d| = s·k/n for k = 1..n with alternating signs: nearest-rank P95 = s·⌈0.95n⌉/n. */
function ladder(n: number, s: number): DeviationDistances {
  const values = new Float32Array(n);
  for (let k = 1; k <= n; k++) values[k - 1] = (k % 2 ? 1 : -1) * (s * k) / n;
  return { values, assets: [{ expressId: 7, modelIndex: 0, offset: 0, count: n }] };
}

function stat(container: HTMLElement, key: string): string {
  return container.querySelector(`[data-stat="${key}"] dd`)?.textContent ?? '';
}

function histogramTotal(container: HTMLElement): number {
  return [...container.querySelectorAll('[data-testid="deviation-histogram"] [data-count]')]
    .reduce((sum, bar) => sum + Number(bar.getAttribute('data-count')), 0);
}

function withinText(container: HTMLElement): string | undefined {
  return container.querySelector('[data-testid="deviation-within-tolerance"]')?.textContent ?? undefined;
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent === label);
}

/** A renderer whose distance readbacks resolve only when the test says so. */
function stubRenderer() {
  const readbacks: Array<(distances: DeviationDistances) => void> = [];
  let computeCalls = 0;
  const renderer = {
    async computeDeviations() {
      computeCalls++;
      return {
        bvhTriangles: 1, bvhNodes: 1, chunksProcessed: 1, pointsProcessed: 1000,
        bounds: null, suggestedHalfRange: 0.05,
      };
    },
    readDeviationDistances() {
      return new Promise<DeviationDistances>((resolve) => { readbacks.push(resolve); });
    },
  } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  return { readbacks, computeCalls: () => computeCalls };
}

/** Records what `downloadFile` offers the browser while `run` and its async tail execute. */
async function captureDownloads(run: () => Promise<void>): Promise<Array<{ filename: string; text: string }>> {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  const blobs: Blob[] = [];
  const filenames: string[] = [];
  URL.createObjectURL = ((b: Blob) => { blobs.push(b); return 'blob:deviation-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filenames.push(this.download); };
  try {
    await run();
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  return Promise.all(blobs.map(async (blob, i) => ({ filename: filenames[i] ?? '', text: await blob.text() })));
}

/** Click Compute and resolve its readback with `distances`; the summary is on screen after. */
async function computeWith(container: HTMLElement, stub: ReturnType<typeof stubRenderer>, distances: DeviationDistances) {
  const before = stub.readbacks.length;
  click(container.querySelector('button') as HTMLButtonElement);
  await waitFor(() => stub.readbacks.length === before + 1, 'distance readback started');
  await act(async () => { stub.readbacks[before](distances); });
  await waitFor(() => stat(container, 'p95Abs') !== '' && withinText(container) !== undefined, 'statistics rendered');
}

it('DeviationPanel #6872 shows readback statistics and updates them when the readback changes', async () => {
  const stub = stubRenderer();
  useViewerStore.getState().setPointCloudColorMode('rgb');

  const container = render(<DeviationPanel triangleCount={1} />);
  const compute = container.querySelector('button') as HTMLButtonElement;
  click(compute);
  await waitFor(() => stub.readbacks.length === 1, 'distance readback started');
  // The readback belongs to the run: no second compute can interleave with it.
  assert.ok(compute.disabled);
  click(compute);
  assert.equal(stub.computeCalls(), 1);
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);

  await act(async () => { stub.readbacks[0](ladder(1000, 0.04)); });
  await waitFor(() => stat(container, 'p95Abs') !== '' && withinText(container) !== undefined, 'statistics rendered');
  assert.equal(stat(container, 'p95Abs'), '38.0 mm');
  assert.equal(stat(container, 'p50Abs'), '20.0 mm');
  assert.equal(stat(container, 'maxAbs'), '40.0 mm');
  assert.equal(stat(container, 'meanAbs'), '20.0 mm');
  // Default ±10 mm band: |d| = 0.04k/1000 ≤ 0.01 for k ≤ 250.
  assert.equal(withinText(container), '25% within ±10 mm (250 of 1,000)');
  assert.equal(histogramTotal(container), 1000);

  // Editing the tolerance and the ramp range re-derive share and bars.
  type(container.querySelector('input[type="number"]') as HTMLInputElement, '20');
  await waitFor(() => withinText(container) === '50% within ±20 mm (500 of 1,000)', 'tolerance share updated');
  act(() => { useViewerStore.getState().setPointCloudDeviationHalfRange(0.02); });
  await waitFor(() => histogramTotal(container) === 500, 'histogram re-binned to ±20 mm');

  const [csv, ...extra] = await captureDownloads(async () => {
    click(button(container, 'Export CSV')!);
    await waitFor(() => button(container, 'Export CSV') !== undefined && !button(container, 'Export CSV')!.disabled, 'export finished');
  });
  assert.equal(extra.length, 0);
  assert.equal(csv.filename, 'model-deviation.csv');
  const [header, row] = csv.text.trimEnd().split('\n');
  const cell = (name: string) => Number(row.split(',')[header.split(',').indexOf(name)]);
  assert.equal(cell('P95AbsoluteDeviationM'), Math.fround(0.038));
  assert.equal(cell('ToleranceM'), 0.02);
  assert.equal(cell('WithinTolerancePoints'), 500);

  // A recompute reads back again; the panel shows the NEW run, not the old.
  click(compute);
  await waitFor(() => stub.readbacks.length === 2, 'second readback started');
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  await act(async () => { stub.readbacks[1](ladder(400, 0.004)); });
  await waitFor(() => stat(container, 'p95Abs') === '3.8 mm', 'second statistics rendered');
  assert.equal(stat(container, 'maxAbs'), '4.0 mm');
  await waitFor(() => withinText(container) === '100% within ±20 mm (400 of 400)', 'second share rendered');
});

it('DeviationPanel #5832 keeps Recompute disabled while a CSV export is running', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  await computeWith(container, stub, ladder(1000, 0.04));
  const compute = container.querySelector('button') as HTMLButtonElement;

  const downloads = await captureDownloads(async () => {
    click(button(container, 'Export CSV')!);
    // The export's passes run in yielding slices; until they finish, a
    // recompute would replace the readback the CSV is being built from.
    assert.ok(compute.disabled, 'Recompute disabled during export');
    assert.ok(button(container, 'Exporting CSV…')?.disabled);
    click(compute);
    await waitFor(() => button(container, 'Export CSV') !== undefined, 'export finished');
  });
  assert.equal(stub.computeCalls(), 1);
  assert.equal(downloads.length, 1);
  assert.ok(!compute.disabled, 'Recompute re-enabled after export');
});

it('DeviationPanel #6872 drops an export whose readback is invalidated mid-run (placement, removal, device loss)', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  await computeWith(container, stub, ladder(1000, 0.04));

  const downloads = await captureDownloads(async () => {
    click(button(container, 'Export CSV')!);
    // Every invalidator (placement sync, removeModel, device-loss recovery)
    // lands as `pointCloudDeviationComputed = false`.
    act(() => { useViewerStore.getState().setPointCloudDeviationComputed(false); });
    await waitFor(() => (container.textContent ?? '').includes('Deviation results changed during export'), 'export reported stale');
  });
  assert.equal(downloads.length, 0, 'no CSV of an invalidated run');
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  assert.equal(button(container, 'Export CSV'), undefined);
  assert.ok(!(container.querySelector('button') as HTMLButtonElement).disabled);
});

it('DeviationPanel #6872 never adopts a readback whose run was invalidated while it was in flight', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  click(container.querySelector('button') as HTMLButtonElement);
  await waitFor(() => stub.readbacks.length === 1, 'distance readback started');

  // The run is invalidated while its distances are still in flight, as
  // placement sync does it (flag down, heatmap off). Holding that array
  // would pin 4 B/point for a run nothing shows, and any later `computed =
  // true` would surface it as current.
  act(() => {
    useViewerStore.getState().setPointCloudDeviationComputed(false);
    useViewerStore.getState().setPointCloudColorMode('rgb');
  });
  await act(async () => { stub.readbacks[0](ladder(1000, 0.04)); });
  await waitFor(() => !(container.querySelector('button') as HTMLButtonElement).disabled, 'run settled');
  act(() => { useViewerStore.getState().setPointCloudDeviationComputed(true); });
  await waitFor(() => (container.textContent ?? '').includes('Model positions changed'), 'stale run reported');

  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  assert.equal(container.querySelector('[data-testid="deviation-summary-pending"]'), null);
  assert.equal(button(container, 'Export CSV'), undefined);
});

it('DeviationPanel #6872 pools every point of every scan asset into the CSV summary row, not their averages', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  // Asset A: 900 points with |d| ≤ 9 mm. Asset B: 100 points at 50-149 mm.
  const values = new Float32Array(1000);
  for (let k = 0; k < 900; k++) values[k] = (k % 2 ? -1 : 1) * (k % 10) / 1000;
  for (let k = 0; k < 100; k++) values[900 + k] = (50 + k) / 1000;
  await computeWith(container, stub, {
    values,
    assets: [
      { expressId: 7, modelIndex: 0, offset: 0, count: 900 },
      { expressId: 8, modelIndex: 0, offset: 900, count: 100 },
    ],
  });
  const [csv] = await captureDownloads(async () => {
    click(button(container, 'Export CSV')!);
    await waitFor(() => button(container, 'Export CSV') !== undefined, 'export finished');
  });
  const [header, a, b, pooled, ...rest] = csv.text.trimEnd().split('\n');
  assert.equal(rest.length, 0);
  const cell = (row: string, name: string) => Number(row.split(',')[header.split(',').indexOf(name)]);
  // Oracle: nearest-rank P95 of the sorted pooled |d| (rank 950 → the 50th of B).
  const sorted = Float32Array.from(values, Math.abs).sort();
  assert.equal(cell(pooled, 'P95AbsoluteDeviationM'), sorted[949]);
  assert.equal(cell(pooled, 'P95AbsoluteDeviationM'), Math.fround(0.099));
  assert.notEqual(cell(pooled, 'P95AbsoluteDeviationM'),
    (cell(a, 'P95AbsoluteDeviationM') + cell(b, 'P95AbsoluteDeviationM')) / 2);
  assert.equal(cell(pooled, 'PointsProcessed'), 1000);
  // Within ±10 mm: all of A, none of B.
  assert.equal(cell(pooled, 'WithinTolerancePoints'), 900);
  assert.equal(cell(pooled, 'MaxAbsoluteDeviationM'), Math.fround(0.149));
});

it('DeviationPanel #6872 keeps a valid heatmap when only the statistics readback fails', async () => {
  // The compute pass succeeded, so its heatmap is correct; a failed readback
  // only withholds the statistics. Device loss clears `computed` on its own
  // (device-loss recovery), so nothing here needs to.
  setGlobalRendererRef({
    current: {
      async computeDeviations() {
        return { bvhTriangles: 1, bvhNodes: 1, chunksProcessed: 1, pointsProcessed: 10, bounds: null, suggestedHalfRange: 0.05 };
      },
      async readDeviationDistances() { throw new Error('mapAsync failed: out of memory'); },
    } as unknown as Renderer,
  });
  const container = render(<DeviationPanel triangleCount={1} />);
  const compute = container.querySelector('button') as HTMLButtonElement;
  click(compute);
  await waitFor(() => (container.textContent ?? '').includes('mapAsync failed'), 'readback error shown');
  await waitFor(() => !compute.disabled, 'Recompute available');
  assert.equal(useViewerStore.getState().pointCloudDeviationComputed, true);
  assert.equal(useViewerStore.getState().pointCloudColorMode, 'deviation');
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  assert.equal(button(container, 'Export CSV'), undefined);
});

it('DeviationPanel #6872 re-reads its statistics when COPC LOD streaming re-runs deviation (#6880)', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  await computeWith(container, stub, ladder(1000, 0.04));
  assert.equal(stat(container, 'maxAbs'), '40.0 mm');

  // A settled LOD pass re-ran deviation on a new chunk set: the old readback
  // describes chunks no longer drawn, so it is dropped and read again.
  act(() => { useViewerStore.getState().bumpPointCloudDeviationRevision(); });
  await waitFor(() => stub.readbacks.length === 2, 'refresh readback started');
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  assert.equal(button(container, 'Export CSV'), undefined);
  await act(async () => { stub.readbacks[1](ladder(400, 0.004)); });
  await waitFor(() => stat(container, 'maxAbs') === '4.0 mm', 'refreshed statistics rendered');
  assert.equal(stub.computeCalls(), 1, 'the refresh reads back; it does not recompute');
});

it('DeviationPanel #6872 a re-run that lands during the panel readback is read again afterwards', async () => {
  const stub = stubRenderer();
  const container = render(<DeviationPanel triangleCount={1} />);
  click(container.querySelector('button') as HTMLButtonElement);
  await waitFor(() => stub.readbacks.length === 1, 'distance readback started');
  act(() => { useViewerStore.getState().bumpPointCloudDeviationRevision(); });
  await act(async () => { stub.readbacks[0](ladder(1000, 0.04)); });
  // That readback may predate the re-run, so a second one follows.
  await waitFor(() => stub.readbacks.length === 2, 'follow-up readback started');
  await act(async () => { stub.readbacks[1](ladder(400, 0.004)); });
  await waitFor(() => stat(container, 'maxAbs') === '4.0 mm', 'latest run shown');
});

it('DeviationPanel #6880 a readback a COPC re-run superseded is replaced by the refresh, and its error cleared', async () => {
  const reads: Array<{ resolve: (d: DeviationDistances) => void; reject: (e: Error) => void }> = [];
  setGlobalRendererRef({
    current: {
      async computeDeviations() {
        return { bvhTriangles: 1, bvhNodes: 1, chunksProcessed: 1, pointsProcessed: 1000, bounds: null, suggestedHalfRange: 0.05 };
      },
      readDeviationDistances() {
        return new Promise<DeviationDistances>((resolve, reject) => { reads.push({ resolve, reject }); });
      },
    } as unknown as Renderer,
  });
  const container = render(<DeviationPanel triangleCount={1} />);
  click(container.querySelector('button') as HTMLButtonElement);
  await waitFor(() => reads.length === 1, 'panel readback started');
  // A settled LOD pass re-ran deviation under the panel's readback: the
  // renderer refuses the mixed read and the sink announces the new run.
  await act(async () => {
    useViewerStore.getState().bumpPointCloudDeviationRevision();
    reads[0].reject(new Error('Deviation results changed during readback. Recompute and try again.'));
  });
  await waitFor(() => reads.length === 2, 'refresh readback started');
  await act(async () => { reads[1].resolve(ladder(400, 0.004)); });
  await waitFor(() => stat(container, 'maxAbs') === '4.0 mm', 'refreshed statistics rendered');
  assert.ok(!(container.textContent ?? '').includes('changed during readback'), 'the superseded read\'s error is gone');
  assert.ok(button(container, 'Export CSV'), 'the refreshed run can be exported');
});
