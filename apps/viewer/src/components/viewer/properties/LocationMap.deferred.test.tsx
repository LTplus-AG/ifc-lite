/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { advance, cleanup, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { LocationMap } from './LocationMap.js';

const conversion = { id: 1, sourceCRS: 2, targetCRS: 3,
  eastings: 500_000, northings: 4_000_000, orthogonalHeight: 0 };
const crs = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };

for (const phase of ['queue', 'fragments', 'finalising'] as const) {
  it(`NEW-7: real LocationMap defers WebGL while scene ${phase} remains after UI settlement`, async () => {
    const originalRenderer = getGlobalRenderer();
    const originalState = useViewerStore.getState();
    let busy = true;
    let polls = 0;
    const scene = {
      hasQueuedMeshes() { polls++; return phase === 'queue' && busy; },
      hasStreamingFragments: () => phase === 'fragments' && busy,
      isFinalizeInProgress: () => phase === 'finalising' && busy,
    };
    setGlobalRendererRef({ current: { getScene: () => scene } as unknown as Renderer });
    let probes = 0;
    const context = mock.method(HTMLCanvasElement.prototype, 'getContext', () => { probes++; return null; });
    resetMapWebglSupportForTests();
    useViewerStore.setState({ loading: true, geometryStreamingActive: false, pendingInstancedShards: [] });
    try {
      const ui = render(<LocationMap mapConversion={conversion} projectedCRS={crs} />);
      await waitFor(() => !!ui.querySelector('a[href*="google.com/maps"]'), 'georeference resolves');
      assert.equal(probes, 0);
      act(() => useViewerStore.setState({ loading: false }));
      // Reverted main reaches the GPU; the branch polls the real scene
      // protocol instead. Both execute the existing component entry point.
      await waitFor(() => polls > 0 || probes > 0, 'scene fence or WebGL setup');
      assert.equal(probes, 0, 'UI settlement must not run map setup during scene work');
      busy = false;
      await waitFor(() => probes > 0, 'scene settlement releases real WebGL setup');
      const settledPolls = polls;
      act(() => useViewerStore.setState({ loading: true }));
      busy = true;
      await advance(30);
      act(() => useViewerStore.setState({ loading: false }));
      await advance(30);
      assert.equal(polls, settledPolls, 'ready remains latched across later loads');
    } finally {
      cleanup();
      context.mock.restore();
      setGlobalRendererRef({ current: originalRenderer });
      resetMapWebglSupportForTests();
      useViewerStore.setState({ loading: originalState.loading,
        geometryStreamingActive: originalState.geometryStreamingActive,
        pendingInstancedShards: originalState.pendingInstancedShards });
    }
  });
}

it('NEW-7: a settled model without a WebGPU renderer still gets its map', async () => {
  const originalRenderer = getGlobalRenderer();
  const originalState = useViewerStore.getState();
  setGlobalRendererRef({ current: null });
  let probes = 0;
  const context = mock.method(HTMLCanvasElement.prototype, 'getContext', () => { probes++; return null; });
  resetMapWebglSupportForTests();
  useViewerStore.setState({ loading: false, geometryStreamingActive: false, pendingInstancedShards: [] });
  try {
    render(<LocationMap mapConversion={conversion} projectedCRS={crs} />);
    await waitFor(() => probes > 0, 'metadata-only/no-renderer fallback');
  } finally {
    cleanup();
    context.mock.restore();
    setGlobalRendererRef({ current: originalRenderer });
    resetMapWebglSupportForTests();
    useViewerStore.setState({ loading: originalState.loading,
      geometryStreamingActive: originalState.geometryStreamingActive,
      pendingInstancedShards: originalState.pendingInstancedShards });
  }
});
