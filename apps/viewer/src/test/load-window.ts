/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { act } from 'react';

/**
 * Let the load window close after the store settled: it closes one painted
 * frame later, in a task behind that frame (hooks/loadWindow.ts), so the
 * whole-model consumers do not delay the settled frame. Await this after the
 * store change that ends a load, before asserting settled values.
 */
export async function settleLoadWindow(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
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
