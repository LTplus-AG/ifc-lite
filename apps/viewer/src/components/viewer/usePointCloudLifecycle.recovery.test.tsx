/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { GeometryResult, PointCloudAsset } from '@ifc-lite/geometry';
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore, type FederatedModel } from '@/store';
import { fixtureModel } from '@/test/store-fixture.js';
import { usePointCloudSync } from './usePointCloudSync.js';
import { usePointCloudLifecycle } from './usePointCloudLifecycle.js';

const inlineAsset = {
  chunk: { pointCount: 1, positions: new Float32Array([0, 0, 0]) },
} as unknown as PointCloudAsset;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  useViewerStore.setState({ models: new Map(), pointCloudAssetCount: 0 });
});

it('keeps rebuilt IFCx count when stale streamed handles are cleaned after recovery (#4885)', () => {
  let inlineCount = 0, streamedPresent = true;
  const removed: number[] = [];
  const visibility: Array<readonly [number, boolean]> = [];
  const renderer = {
    setPointClouds: (assets: readonly PointCloudAsset[]) => { inlineCount = assets.length; },
    getPointCloudAssetCount: () => inlineCount + (streamedPresent ? 1 : 0),
    removePointCloudAsset: (handle: { id: number }) => {
      removed.push(handle.id);
      if (handle.id === 7) streamedPresent = false;
    },
    setPointCloudVisibility: (handle: { id: number }, visible: boolean) => { visibility.push([handle.id, visible]); },
    setPointCloudOptions: () => {},
    setEdlOptions: () => {},
    getModelBounds: () => null,
    requestRender: () => {},
  } as unknown as Renderer;
  const rendererRef = { current: renderer };
  let pointClouds: readonly PointCloudAsset[] = [inlineAsset];
  const streamed: FederatedModel = { ...fixtureModel('scan'), pointCloudHandleId: 7 };
  const inline: FederatedModel = {
    ...fixtureModel('ifcx'),
    geometryResult: { pointClouds: [inlineAsset] } as unknown as GeometryResult,
  };
  useViewerStore.setState({
    models: new Map<string, FederatedModel>([['scan', streamed], ['ifcx', inline]]),
    pointCloudAssetCount: 2,
  });

  function Probe() {
    usePointCloudSync({ rendererRef, isInitialized: true, pointClouds, hasMeshes: true });
    usePointCloudLifecycle({ rendererRef, isInitialized: true });
    return null;
  }

  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<Probe />));
  assert.strictEqual(useViewerStore.getState().pointCloudAssetCount, 2);
  assert.deepStrictEqual(visibility, [[7, true]], 'the lifecycle mirrors streamed-model visibility to the renderer');

  // Device recovery has already dropped streamed GPU assets. It clones the
  // IFCx owner (so sync uploads it) and removes the stale streamed handle.
  streamedPresent = false;
  pointClouds = [inlineAsset];
  act(() => {
    useViewerStore.setState({ models: new Map([['ifcx', { ...inline }]]) });
    root?.render(<Probe />);
  });

  assert.deepStrictEqual(removed, [7]);
  assert.strictEqual(useViewerStore.getState().pointCloudAssetCount, 1,
    'stale streamed cleanup cannot decrement the rebuilt inline asset');
});

it('does not unmount the app when the renderer is torn down by a device loss (#5147)', () => {
  // The main-page failure the CI trace showed: the scan loaded, SwiftShader
  // lost the WebGPU device, the renderer tore its point-cloud pipeline down,
  // and this hook's effect called setPointClouds on it — an uncaught throw
  // that emptied #root while the store still held the model.
  let ready = false;
  let synced = 0;
  const renderer = {
    isReady: () => ready,
    setPointClouds: () => {
      if (!ready) throw new Error('Renderer not initialized. Call init() first.');
      synced++;
    },
    getPointCloudAssetCount: () => synced,
    setPointCloudOptions: () => {},
    setEdlOptions: () => {},
    getModelBounds: () => null,
    requestRender: () => {},
  } as unknown as Renderer;
  const rendererRef = { current: renderer };
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };

  function Probe() {
    usePointCloudSync({ rendererRef, isInitialized: true, pointClouds: [inlineAsset], hasMeshes: false });
    return <div data-testid="alive" />;
  }

  try {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root?.render(<Probe />));
    assert.ok(host.querySelector('[data-testid="alive"]'), 'the tree survives a torn-down renderer');
    assert.strictEqual(synced, 0);
    assert.ok(warnings.some((w) => w.includes('[usePointCloudSync]') && w.includes('device lost')), `the skip is logged: ${warnings.join(' | ')}`);

    // Recovery re-inits the renderer; the next render (a fresh asset list
    // literal, so the effect re-runs) syncs again.
    ready = true;
    act(() => root?.render(<Probe />));
    assert.strictEqual(synced, 1, 'a ready renderer is synced');
  } finally {
    console.warn = originalWarn;
  }
});
