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

/** Records what `downloadFile` actually offered the browser. */
async function captureCsv(run: () => void): Promise<{ filename: string; text: string }> {
  const originalCreate = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  let filename = '';
  let blob: Blob | undefined;
  URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:deviation-test'; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filename = this.download; };
  try {
    run();
  } finally {
    URL.createObjectURL = originalCreate;
    HTMLAnchorElement.prototype.click = originalClick;
  }
  assert.ok(blob, 'no CSV was offered for download');
  return { filename, text: await blob.text() };
}

it('DeviationPanel #6872 shows readback statistics and updates them when the readback changes', async () => {
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
  useViewerStore.getState().setPointCloudColorMode('rgb');

  const container = render(<DeviationPanel triangleCount={1} />);
  const compute = container.querySelector('button') as HTMLButtonElement;
  click(compute);
  await waitFor(() => readbacks.length === 1, 'distance readback started');
  // The readback belongs to the run: no second compute can interleave with it.
  assert.ok(compute.disabled);
  click(compute);
  assert.equal(computeCalls, 1);
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);

  await act(async () => { readbacks[0](ladder(1000, 0.04)); });
  await waitFor(() => stat(container, 'p95Abs') !== '', 'statistics rendered');
  assert.equal(stat(container, 'p95Abs'), '38.0 mm');
  assert.equal(stat(container, 'p50Abs'), '20.0 mm');
  assert.equal(stat(container, 'maxAbs'), '40.0 mm');
  assert.equal(stat(container, 'meanAbs'), '20.0 mm');
  // Default ±10 mm band: |d| = 0.04k/1000 ≤ 0.01 for k ≤ 250.
  const within = () => container.querySelector('[data-testid="deviation-within-tolerance"]')?.textContent;
  assert.equal(within(), '25% within ±10 mm (250 of 1,000)');
  assert.equal(histogramTotal(container), 1000);

  // Editing the tolerance and the ramp range re-derive share and bars.
  type(container.querySelector('input[type="number"]') as HTMLInputElement, '20');
  assert.equal(within(), '50% within ±20 mm (500 of 1,000)');
  act(() => { useViewerStore.getState().setPointCloudDeviationHalfRange(0.02); });
  assert.equal(histogramTotal(container), 500);

  const csv = await captureCsv(() => {
    const exportButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Export CSV');
    assert.ok(exportButton);
    click(exportButton);
  });
  assert.equal(csv.filename, 'model-deviation.csv');
  const [header, row] = csv.text.trimEnd().split('\n');
  const cell = (name: string) => Number(row.split(',')[header.split(',').indexOf(name)]);
  assert.equal(cell('P95AbsoluteDeviationM'), Math.fround(0.038));
  assert.equal(cell('ToleranceM'), 0.02);
  assert.equal(cell('WithinTolerancePoints'), 500);

  // A recompute reads back again; the panel shows the NEW run, not the old.
  click(compute);
  await waitFor(() => readbacks.length === 2, 'second readback started');
  assert.equal(container.querySelector('[data-testid="deviation-summary"]'), null);
  await act(async () => { readbacks[1](ladder(400, 0.004)); });
  await waitFor(() => stat(container, 'p95Abs') !== '', 'second statistics rendered');
  assert.equal(stat(container, 'p95Abs'), '3.8 mm');
  assert.equal(stat(container, 'maxAbs'), '4.0 mm');
  assert.equal(within(), '100% within ±20 mm (400 of 400)');
});
