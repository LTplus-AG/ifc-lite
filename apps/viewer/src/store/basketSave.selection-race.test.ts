/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, type RefObject } from 'react';
import type { Renderer } from '@ifc-lite/renderer';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import { render, cleanup } from '@/test/render.js';
import { useChart3DLink } from '@/components/viewer/charts/useChart3DLink.js';
import { useViewerStore } from './index.js';
import { saveBasketViewWithThumbnailFromStore } from './basketSave.js';
import { registerViewportCapture } from '@/lib/viewport-capture';

let releaseGpu: () => void;
let unregisterCapture: (() => void) | undefined;

function ChartLinkProbe() {
  useChart3DLink();
  return null;
}

beforeEach(() => {
  const gate = new Promise<void>((resolve) => { releaseGpu = resolve; });
  const renderer = {
    render: () => {},
    requestRender: () => {},
    getGPUDevice: () => ({ queue: { onSubmittedWorkDone: () => gate } }),
  } as unknown as Renderer;
  setGlobalRendererRef({ current: renderer } as RefObject<Renderer | null>);
  const canvas = document.createElement('canvas');
  canvas.dataset.viewport = 'main';
  canvas.toDataURL = () => 'data:image/png;base64,AA==';
  document.body.appendChild(canvas);
  unregisterCapture = registerViewportCapture(renderer, canvas, () => ({}));
  useViewerStore.setState((state) => {
    const visibilityRevision = state.visibilityRevision + 1;
    const ids = new Set([44, 45]);
    return {
      selectedEntityId: 44,
      selectedEntityIds: new Set([44, 45]),
      selectedEntity: { modelId: 'm1', expressId: 44 },
      selectedEntitiesSet: new Set(['m1:44', 'm1:45']),
      selectedEntities: [{ modelId: 'm1', expressId: 44 }, { modelId: 'm1', expressId: 45 }],
      selectedModelId: null,
      selectionRevision: 4,
      chartSlice: new Set([44, 45]),
      chartSliceSource: 'doors',
      chartSliceBuckets: [{ seriesKey: 'type', bucketKey: 'IfcDoor', isOther: false, color: '#f00', ids: [44, 45] }],
      chartSelectionRevision: 4,
      ghostExceptEntities: ids,
      isolatedEntities: null,
      chartVisibilityOwned: { channel: 'ghost', ids },
      chartVisibilityRevision: visibilityRevision,
    };
  });
});

afterEach(() => {
  unregisterCapture?.(); unregisterCapture = undefined;
  document.querySelectorAll('canvas[data-viewport="main"]').forEach((canvas) => canvas.remove());
  setGlobalRendererRef({ current: null });
  cleanup();
  releaseGpu();
});

describe('basket thumbnail selection provenance (#4832)', () => {
  it('does not restore a stale snapshot over a selection made during capture', async () => {
    const saving = saveBasketViewWithThumbnailFromStore();
    await Promise.resolve();
    assert.equal(useViewerStore.getState().selectedEntityIds.size, 0, 'capture clears the outline');

    useViewerStore.getState().setSelectedEntityIds([99]);
    useViewerStore.getState().setSelectedEntityId(99);
    releaseGpu();
    await saving;

    assert.deepEqual([...useViewerStore.getState().selectedEntityIds], [99]);
    assert.equal(useViewerStore.getState().selectedEntityId, 99);
  });

  it('restores chart producer provenance when no newer selection intervenes', async () => {
    const saving = saveBasketViewWithThumbnailFromStore();
    releaseGpu();
    await saving;

    const state = useViewerStore.getState();
    assert.deepEqual([...state.selectedEntityIds], [44, 45]);
    assert.equal(state.chartSelectionRevision, state.selectionRevision);
  });

  it('keeps complete chart provenance while delayed GPU capture hides the outline', async () => {
    render(createElement(ChartLinkProbe));
    const before = useViewerStore.getState();
    const saving = saveBasketViewWithThumbnailFromStore();
    await Promise.resolve();

    const during = useViewerStore.getState();
    assert.equal(during.selectedEntityIds.size, 0, 'thumbnail capture temporarily hides selection');
    assert.strictEqual(during.chartSlice, before.chartSlice, 'logical chart ownership is not torn down');
    assert.deepEqual(during.chartSliceBuckets, before.chartSliceBuckets);
    assert.deepEqual([...(during.ghostExceptEntities ?? [])], [44, 45]);
    assert.equal(during.chartVisibilityOwned?.channel, 'ghost');

    releaseGpu();
    await saving;
    const after = useViewerStore.getState();
    assert.deepEqual([...after.selectedEntityIds], [44, 45]);
    assert.strictEqual(after.chartSlice, before.chartSlice);
    assert.equal(after.chartSelectionRevision, after.selectionRevision);
    assert.deepEqual([...(after.ghostExceptEntities ?? [])], [44, 45]);
    assert.equal(after.chartVisibilityOwned?.channel, 'ghost');
  });
});
