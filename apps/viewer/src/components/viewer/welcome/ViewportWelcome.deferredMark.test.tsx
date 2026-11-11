/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The start screen's 3D mark waits for the first idle period. Its WebGL
 * context and shader links used to start in the same task as the start
 * screen's first commit, so a file picked at first paint queued behind them.
 * A start screen that is gone before that idle period (a file was opened)
 * never starts the mark at all.
 */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { cleanup, render } from '@/test/render.js';
import { ViewportWelcome } from './ViewportWelcome.js';

type IdleCb = () => void;
const pending = new Map<number, IdleCb>();
const cancelled: number[] = [];
let nextHandle = 1;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  pending.clear();
  cancelled.length = 0;
  for (const k of ['requestIdleCallback', 'cancelIdleCallback', 'ResizeObserver'] as const) saved[k] = (window as unknown as Record<string, unknown>)[k];
  Object.assign(window, {
    requestIdleCallback: (cb: IdleCb) => { const h = nextHandle++; pending.set(h, cb); return h; },
    cancelIdleCallback: (h: number) => { cancelled.push(h); pending.delete(h); },
    // Every observed element reports a wide viewport, so the mark has room.
    ResizeObserver: class {
      constructor(private readonly cb: (entries: Array<{ contentRect: { width: number } }>) => void) {}
      observe() { this.cb([{ contentRect: { width: 1400 } }]); }
      disconnect() {}
    },
  });
});

afterEach(() => {
  cleanup();
  Object.assign(window, saved);
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

describe('welcome 3D mark waits for idle', () => {
  it('keeps the mark box but does not start the mark until the first idle period', () => {
    const screen = renderWelcome();
    assert.equal(markState(screen), 'deferred', 'the box is laid out, the mark is not started');
    assert.equal(pending.size, 1, 'one idle callback is scheduled');
    act(() => { for (const cb of [...pending.values()]) cb(); });
    assert.equal(markState(screen), 'mounted');
  });

  it('a start screen that goes away before idle never starts the mark', () => {
    renderWelcome();
    const [handle] = [...pending.keys()];
    cleanup();
    assert.deepEqual(cancelled, [handle], 'the idle callback is cancelled on unmount');
    assert.equal(pending.size, 0);
  });
});
