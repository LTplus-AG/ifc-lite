/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen's 3D mark waits for the first quiet moment. Its WebGL
 * context and shader links used to start in the same task as the start
 * screen's first commit, so a file picked at first paint queued behind them
 * (2-3 s on ANGLE/Vulkan). A model open asked for before that moment (a
 * pick, drop or Open click, `markLoadIntent`) cancels the pending start at
 * once, before any await on the way to `loading`.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render, waitFor } from '@/test/render.js';
import { ViewportWelcome } from './ViewportWelcome.js';

// Loaded at runtime: the changed-test oracle removes new production files, and
// a missing module must fail an assertion rather than the whole file's import.
const intentPath = '../../../lib/load-intent.js';
const intent: typeof import('../../../lib/load-intent.js') | null = await import(intentPath).catch(() => null);
const SAMPLE_MS = 50; // welcome-mark-schedule.ts

type IdleCb = () => void;
const pending = new Map<number, IdleCb>();
const requested: Array<{ cb: IdleCb; timeout: number | undefined }> = [];
const cancelled: number[] = [];
let nextHandle = 1;
const saved: Record<string, unknown> = {};
const KEYS = ['requestIdleCallback', 'cancelIdleCallback', 'ResizeObserver'] as const;

function stubIdle() {
  Object.assign(window, {
    requestIdleCallback: (cb: IdleCb, options?: { timeout?: number }) => { const h = nextHandle++; pending.set(h, cb); requested.push({ cb, timeout: options?.timeout }); return h; },
    cancelIdleCallback: (h: number) => { cancelled.push(h); pending.delete(h); },
  });
}

beforeEach(() => {
  pending.clear();
  requested.length = 0;
  cancelled.length = 0;
  intent?.resetLoadIntentForTests();
  for (const k of KEYS) saved[k] = (window as unknown as Record<string, unknown>)[k];
  // Every observed element reports a wide viewport, so the mark has room.
  Object.assign(window, {
    ResizeObserver: class {
      constructor(private readonly cb: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.cb([{ contentRect: { width: 1400 } }]); }
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  for (const k of KEYS) (window as unknown as Record<string, unknown>)[k] = saved[k];
  intent?.resetLoadIntentForTests();
});

function renderWelcome() {
  return render(
    <ViewportWelcome
      webgpu={{ supported: true, checking: false }}
      onOpenClick={() => undefined}
      onStartBlank={() => undefined}
      recentFiles={[]}
      loadFile={() => Promise.resolve()}
    />,
  );
}

const markState = (root: ParentNode) => root.querySelector('[data-welcome-mark]')?.getAttribute('data-welcome-mark') ?? null;

describe('welcome 3D mark waits for a quiet moment', () => {
  it('keeps the mark box but starts the mark only at the idle period, bounded at 2 s', () => {
    stubIdle();
    const screen = renderWelcome();
    assert.equal(markState(screen), 'deferred', 'the box is laid out, the mark is not started');
    assert.equal(requested.length, 1, 'one idle callback is scheduled');
    assert.equal(requested[0].timeout, 2000, 'a busy page still gets the mark after 2 s');
    act(() => { for (const cb of [...pending.values()]) cb(); });
    assert.equal(markState(screen), 'mounted');
  });

  it('a start screen that goes away before idle never starts the mark', () => {
    stubIdle();
    renderWelcome();
    const [handle] = [...pending.keys()];
    cleanup();
    assert.deepEqual(cancelled, [handle], 'the idle callback is cancelled on unmount');
    assert.equal(pending.size, 0);
  });

  it('a load intent before loading starts cancels the pending start, even if the idle callback still fires', () => {
    stubIdle();
    const screen = renderWelcome();
    const [{ cb: raced }] = requested;
    const [handle] = [...pending.keys()];
    assert.ok(intent, 'a model open announces itself before it awaits (lib/load-intent.ts)');
    act(() => intent.markLoadIntent()); // the pick: before guardWebGpu / prepareAndRoute can await
    assert.ok(cancelled.includes(handle), 'the pending idle start is cancelled at the intent');
    act(() => raced()); // an idle callback already queued by the browser runs anyway
    assert.equal(markState(screen), 'deferred', 'the mark does not start while the open is on its way');
  });

  it('without requestIdleCallback (Safari) it starts after the main thread sampled quiet, and not before', async () => {
    delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    const t0 = performance.now();
    const screen = renderWelcome();
    assert.equal(markState(screen), 'deferred');
    await waitFor(() => markState(screen) === 'mounted', 'the mark starts once the thread samples quiet (or at the 2 s bound)', 5000);
    assert.ok(performance.now() - t0 >= 2 * SAMPLE_MS - 5, 'not before two 50 ms samples');
  });
});
