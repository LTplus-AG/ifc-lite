/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer, DeviationAssetStats } from '@ifc-lite/renderer';
import { cleanup, click, render, waitFor } from '@/test/render.js';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { useViewerStore } from '@/store';
import { DeviationPanel } from './DeviationPanel.js';

afterEach(() => {
  cleanup();
  setGlobalRendererRef({ current: null });
  useViewerStore.getState().setPointCloudDeviationComputed(false);
  useViewerStore.getState().setPointCloudColorMode('rgb');
});

it('DeviationPanel #5832 blocks recompute while CSV GPU readback is pending', async () => {
  let computeCalls = 0;
  let finishReadback: (rows: DeviationAssetStats[]) => void = () => {
    throw new Error('readback was never started');
  };
  const renderer = {
    async computeDeviations() {
      computeCalls++;
      return {
        bvhTriangles: 1, bvhNodes: 1, chunksProcessed: 1, pointsProcessed: 1,
        bounds: null, suggestedHalfRange: 0.05,
      };
    },
    readDeviationAssetStats() {
      return new Promise<DeviationAssetStats[]>((resolve) => { finishReadback = resolve; });
    },
  } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer });
  useViewerStore.getState().setPointCloudColorMode('rgb');
  useViewerStore.getState().setPointCloudDeviationComputed(false);

  const container = render(<DeviationPanel triangleCount={1} />);
  const compute = container.querySelector('button') as HTMLButtonElement;
  assert.ok(compute);
  click(compute);
  await waitFor(() => container.textContent?.includes('Export CSV') ?? false, 'completed deviation run');
  const exportButton = [...container.querySelectorAll('button')].find((button) => button.textContent?.includes('Export CSV'));
  assert.ok(exportButton);
  click(exportButton);
  await waitFor(() => compute.disabled, 'compute disabled during GPU readback');
  click(compute);
  assert.equal(computeCalls, 1);

  await act(async () => { finishReadback([]); });
  await waitFor(() => !compute.disabled, 'compute re-enabled after export');
});
