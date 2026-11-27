/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/content-fixture';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Renderer } from '@ifc-lite/renderer';
import { createBimContext } from '@ifc-lite/sdk';
import { clearGlobalRefs, setGlobalRendererRef } from '@/hooks/useBCF';
import { captureViewportFrame, registerViewportCapture } from '@/lib/viewport-capture';
import { LocalBackend } from '@/sdk/local-backend';
import { useViewerStore } from '@/store';
import { dispatchMainViewerTool } from '../main-viewer-dispatch';
import { createMainViewerToolHost } from '../main-viewer-host';

const screenshotCalls = [
  {
    name: 'exports.screenshot',
    tool: 'viewer_operation_execute',
    args: { operation_id: 'exports.screenshot', input: { scope: 'current-view' } },
  },
  { name: 'viewer_screenshot', tool: 'viewer_screenshot', args: {} },
];

for (const { name, tool, args } of screenshotCalls) {
  it(`${name} never renders a queued frame after cancellation (#10791)`, { timeout: 5000 }, async () => {
    const host = createMainViewerToolHost(useViewerStore, createBimContext({ backend: new LocalBackend(useViewerStore) }));
    let finishFirstFrame = () => {};
    const firstFrame = new Promise<void>(resolve => { finishFirstFrame = resolve; });
    let notifyScreenshotRequested = () => {};
    const screenshotRequested = new Promise<void>(resolve => { notifyScreenshotRequested = resolve; });
    let renders = 0;
    let captures = 0;
    const renderer = {
      renderWithResult: () => { renders++; return true; },
      requestRender: () => {},
      getGPUDevice: () => ({ queue: { onSubmittedWorkDone: () => firstFrame } }),
    } as unknown as Renderer;
    const canvas = document.createElement('canvas');
    canvas.toDataURL = () => 'data:image/png;base64,iVBORw0KGgo=';
    const unregister = registerViewportCapture(renderer, canvas, () => {
      if (++captures === 2) notifyScreenshotRequested();
      return {};
    });
    setGlobalRendererRef({ current: renderer });

    try {
      const first = captureViewportFrame(renderer, { read: () => 'first' });
      const controller = new AbortController();
      const screenshot = dispatchMainViewerTool(host, tool, args, {
        canEdit: () => true,
        signal: controller.signal,
      });
      await screenshotRequested;
      controller.abort();
      const last = captureViewportFrame(renderer, { read: () => 'last' });
      finishFirstFrame();

      assert.equal(await first, 'first');
      assert.equal(await last, 'last');
      assert.equal((await screenshot).errorCode, 'CANCELLED');
      assert.equal(renders, 2, 'the queue drained without rendering the cancelled screenshot');
    } finally {
      finishFirstFrame();
      unregister();
      clearGlobalRefs();
    }
  });
}
