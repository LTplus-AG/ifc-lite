/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { Renderer } from '@ifc-lite/renderer';
import { advance, cleanup, render, waitFor } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { getGlobalRenderer, setGlobalRendererRef } from '@/hooks/useBCF.js';
import { resetMapWebglSupportForTests } from '@/lib/geo/map-webgl-support.js';
import { LocationMap } from './LocationMap.js';

const conversion = { id: 1, sourceCRS: 2, targetCRS: 3,
  eastings: 500_000, northings: 4_000_000, orthogonalHeight: 0 };
const crs = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };

function rendererWithQueuedMesh(): Renderer {
  const renderer = new Renderer(document.createElement('canvas'));
  renderer.getScene().queueMeshes([{ expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }]);
  return renderer;
}

it('NEW-7 #9623: the real Renderer scene supplies every gate method and blocks on its actual queue', async () => {
  const renderer = rendererWithQueuedMesh();
  const scene = renderer.getScene();
  const originalRenderer = getGlobalRenderer();
  const originalState = useViewerStore.getState();
  // No scene facade or casts: missing methods fail here and at typecheck.
  assert.equal(scene.hasQueuedMeshes(), true);
  assert.equal(scene.hasStreamingFragments(), false);
  assert.equal(scene.isFinalizeInProgress(), false);
  const queued = mock.method(scene, 'hasQueuedMeshes');
  const fragments = mock.method(scene, 'hasStreamingFragments');
  const finalising = mock.method(scene, 'isFinalizeInProgress');
  const context = mock.method(HTMLCanvasElement.prototype, 'getContext', () => null);
  setGlobalRendererRef({ current: renderer });
  resetMapWebglSupportForTests();
  useViewerStore.setState({ loading: false, error: null, geometryStreamingActive: false, pendingInstancedShards: [] });
  try {
    const ui = render(<LocationMap mapConversion={conversion} projectedCRS={crs} />);
    await waitFor(() => queued.mock.callCount() > 0, 'real queue queried');
    assert.equal(context.mock.callCount(), 0, 'a real queued mesh prevents WebGL setup');
    assert.match(ui.querySelector('[role="status"]')?.textContent ?? '', /Wait for model loading to finish/);
    scene.clear();
    await waitFor(() => context.mock.callCount() > 0, 'actual queue removal releases WebGL setup');
    assert.ok(fragments.mock.callCount() > 0);
    assert.ok(finalising.mock.callCount() > 0);
  } finally {
    cleanup(); queued.mock.restore(); fragments.mock.restore(); finalising.mock.restore(); context.mock.restore();
    scene.clear(); setGlobalRendererRef({ current: originalRenderer }); resetMapWebglSupportForTests();
    useViewerStore.setState({ loading: originalState.loading, error: originalState.error,
      geometryStreamingActive: originalState.geometryStreamingActive, pendingInstancedShards: originalState.pendingInstancedShards });
  }
});

for (const ending of ['unmount', 'loading', 'error', 'model-change'] as const) {
  it(`NEW-7 #9623: waiting backs off and cancels its old scene checks on ${ending}`, async (t) => {
    const renderer = rendererWithQueuedMesh();
    const originalRenderer = getGlobalRenderer();
    const originalState = useViewerStore.getState();
    const queued = mock.method(renderer.getScene(), 'hasQueuedMeshes');
    const context = mock.method(HTMLCanvasElement.prototype, 'getContext', () => null);
    setGlobalRendererRef({ current: renderer });
    resetMapWebglSupportForTests();
    useViewerStore.setState({ loading: true, error: null, activeModelId: 'waiting-map',
      geometryStreamingActive: false, pendingInstancedShards: [] });
    try {
      const ui = render(<LocationMap mapConversion={conversion} projectedCRS={crs} />);
      await waitFor(() => !!ui.querySelector('a[href*="google.com/maps"]'), 'georeference resolves before clock control');
      t.mock.timers.enable({ apis: ['setTimeout'] });
      act(() => useViewerStore.setState({ loading: false }));
      act(() => t.mock.timers.tick(99));
      assert.equal(queued.mock.callCount(), 0, 'no per-frame polling');
      act(() => t.mock.timers.tick(1));
      assert.equal(queued.mock.callCount(), 1);
      for (let i = 1; i < 50; i++) act(() => t.mock.timers.tick(100));
      assert.equal(queued.mock.callCount(), 50);
      act(() => t.mock.timers.tick(999));
      assert.equal(queued.mock.callCount(), 50, 'never-settling scene backs off to one check/sec');
      act(() => t.mock.timers.tick(1));
      assert.equal(queued.mock.callCount(), 51);
      assert.equal(context.mock.callCount(), 0, 'backoff never opens the busy gate');
      if (ending === 'unmount') cleanup();
      else if (ending === 'loading') act(() => useViewerStore.setState({ loading: true }));
      else if (ending === 'error') act(() => useViewerStore.setState({ error: 'load failed' }));
      else {
        setGlobalRendererRef({ current: null });
        act(() => useViewerStore.setState({ activeModelId: 'replacement-map' }));
      }
      await act(async () => { t.mock.timers.tick(10_000); });
      assert.equal(queued.mock.callCount(), 51, 'the old scene has no remaining timer work');
      if (ending === 'model-change') {
        t.mock.timers.reset();
        await waitFor(() => context.mock.callCount() > 0, 'new renderer-free model gets its own readiness check');
      } else assert.equal(context.mock.callCount(), 0);
    } finally {
      cleanup(); t.mock.timers.reset(); queued.mock.restore(); context.mock.restore(); renderer.getScene().clear();
      setGlobalRendererRef({ current: originalRenderer }); resetMapWebglSupportForTests();
      useViewerStore.setState({ loading: originalState.loading, error: originalState.error, activeModelId: originalState.activeModelId,
        geometryStreamingActive: originalState.geometryStreamingActive, pendingInstancedShards: originalState.pendingInstancedShards });
    }
  });
}

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
    } satisfies Pick<ReturnType<Renderer['getScene']>, 'hasQueuedMeshes' | 'hasStreamingFragments' | 'isFinalizeInProgress'>;
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
      assert.match(ui.querySelector('[role="status"]')?.textContent ?? '', /Wait for model loading to finish/);
      busy = false;
      await waitFor(() => probes > 0, 'scene settlement releases real WebGL setup');
      assert.equal(ui.querySelector('[role="status"]'), null, 'waiting state clears when the gate opens');
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
