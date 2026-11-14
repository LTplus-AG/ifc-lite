/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { act } from 'react';

/**
 * Let the load window close after the store settled: it closes once the
 * settled scene has been drawn (lib/settled-frame.ts; with nothing to draw in a
 * test, two animation frames), in a task behind that frame, so the
 * whole-model consumers do not delay the settled frame. Await this after the
 * store change that ends a load, before asserting settled values. Waits for
 * the transition (`until`, by default the window's close once the store is
 * idle) up to `timeoutMs`, not a fixed delay.
 */
export async function settleLoadWindow(until?: () => boolean, timeoutMs = 2_000): Promise<void> {
  const { viewerLoadWindow } = await import('@/hooks/loadWindow');
  const { useViewerStore } = await import('@/store');
  // Default: once the store is idle, wait for the window to close; mid-load
  // (the store still busy), wait for the frame-paced releases already due.
  const done = until ?? (() => {
    const s = useViewerStore.getState();
    return s.loading || s.geometryStreamingActive || !viewerLoadWindow().isOpen();
  });
  const deadline = Date.now() + timeoutMs;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    while (!done() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/**
 * Run a store change that starts a load (streaming or loading) and let the load
 * window's store-busy limit expire while it stays busy: the window closes and
 * the consumers fall back to computing their values under main's streaming
 * throttle (#6411). `setClock` moves the mocked `performance.now` past the limit.
 */
export async function expireStoreBusyCap(startBusy: () => void, setClock: (ms: number) => void): Promise<void> {
  const { mock } = await import('node:test');
  const { MAX_STORE_BUSY_MS } = await import('@/hooks/loadWindow');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    act(startBusy);
    setClock(MAX_STORE_BUSY_MS + 1);
    act(() => mock.timers.tick(MAX_STORE_BUSY_MS));
    act(() => mock.timers.tick(1_000)); // the close backstop
  } finally {
    mock.timers.reset();
  }
}

/** For `settleLoadWindow(until)`: this model's hold has ended (its own load ended and that frame painted). */
export async function untilReleased(modelId: string): Promise<() => boolean> {
  const { viewerLoadWindow } = await import('@/hooks/loadWindow');
  return () => !viewerLoadWindow().isHeld(modelId);
}
