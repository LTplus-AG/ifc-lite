/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A refused split must not outlive the Split tool (#6233). The error toast
 * used to be a sticky `toast.error`, so "Couldn't split: not a splittable
 * element" stayed on screen after Esc and after selecting something else.
 * Refusals now go through `notifySplitFailed` (transient) and are cleared
 * when the tool's scene unmounts — i.e. on any way of leaving the tool.
 *
 * Driven end to end: the real canvas click handler raises the refusal, the
 * real `ToolOverlays` mounts the Split scene for `activeTool === 'split'`,
 * and switching the tool is what must clear it.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { Toaster } from '@/components/ui/toast';
import { render, cleanup } from '@/test/render.js';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { ToolOverlays } from '../ToolOverlays.js';
import { handleSelectionClick } from '../selectionHandlers.js';
import type { MouseHandlerContext } from '../mouseHandlerTypes.js';

const REFUSAL = "Can't split: the geometry is a mesh or B-rep, not a profile extrusion";

function fakeCtx(): MouseHandlerContext {
  return {
    canvas: document.createElement('canvas'),
    renderer: {},
    mouseState: { isDragging: false, isPanning: false, lastX: 0, lastY: 0, button: 0, startX: 0, startY: 0, didDrag: false },
    activeToolRef: { current: 'split' },
  } as unknown as MouseHandlerContext;
}

function toastTexts(): string[] {
  return [...document.querySelectorAll('button[aria-label="Dismiss notification"]')]
    .map((button) => button.parentElement?.textContent ?? '');
}

const originalReadSplitTarget = useViewerStore.getState().readSplitTarget;

describe('Split tool refusals are scoped to the tool (#6233)', () => {
  beforeEach(() => {
    useViewerStore.setState({
      activeTool: 'split',
      splitMode: 'idle',
      splitTargetModelId: 'm1',
      splitTargetExpressId: 42,
      splitHoverPoint: null,
      splitHoverDistance: null,
      splitHoverLength: null,
      cameraCallbacks: { projectToScreen: () => null, getViewpoint: () => null },
      readSplitTarget: () => ({ ok: false, reasonKey: 'splitTool.unavailable.mesh' }),
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  afterEach(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('button[aria-label="Dismiss notification"]')) {
      act(() => button.click());
    }
    cleanup();
    useViewerStore.setState({
      activeTool: 'select',
      splitTargetModelId: null,
      splitTargetExpressId: null,
      readSplitTarget: originalReadSplitTarget,
    } as unknown as Partial<ReturnType<typeof useViewerStore.getState>>);
  });

  it('shows the predicate\'s reason on click, and clears it when the tool exits', async () => {
    render(<Toaster />);
    render(<SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot>);

    await act(() => handleSelectionClick(fakeCtx(), { clientX: 0, clientY: 0 } as MouseEvent));
    assert.ok(toastTexts().some((text) => text.includes(REFUSAL)), `expected the refusal, got ${JSON.stringify(toastTexts())}`);

    // Leaving the tool (Esc / K / the bar's close all land on setActiveTool).
    act(() => useViewerStore.getState().setActiveTool('select'));
    assert.deepEqual(toastTexts(), [], 'the refusal must not outlive the Split tool');
  });
});
