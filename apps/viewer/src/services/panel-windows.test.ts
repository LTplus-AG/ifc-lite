/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// happy-dom must be registered before anything (including `@/store`, which
// this module and its store subscription touch) evaluates its module body.
import '../test/setup-dom.js';

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getViewerStoreApi } from '@/store';
import {
  closeAllPanelWindows,
  closePanelWindow,
  getPanelWindowsSnapshot,
  openPanelWindow,
  subscribePanelWindows,
  syncPanelWindowsTheme,
} from './panel-windows.js';

/** Minimal fake `Window` covering only what panel-windows.ts touches. */
function fakeWindow() {
  const listeners = new Map<string, Array<() => void>>();
  let closed = false;
  const win = {
    get closed() {
      return closed;
    },
    close: () => {
      closed = true;
    },
    focus: () => {},
    addEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    },
    removeEventListener: (type: string, cb: () => void) => {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    },
    document: {
      title: '',
      documentElement: { className: '', style: {} as Record<string, string> },
      head: { appendChild: () => {} },
      body: { style: {} as Record<string, string> },
      createElement: () => ({}),
    },
  };
  return win as unknown as Window & { close: () => void; readonly closed: boolean };
}

describe('panel-windows', () => {
  let originalOpen: typeof window.open;
  let openedWindows: ReturnType<typeof fakeWindow>[];

  beforeEach(() => {
    // Fresh store slate: poppedOutIds must not leak between tests.
    const api = getViewerStoreApi();
    for (const id of [...api.getState().poppedOutIds]) {
      api.getState().setPanelPoppedOut(id, false);
    }
    closeAllPanelWindows();

    originalOpen = window.open;
    openedWindows = [];
    window.open = (() => {
      const w = fakeWindow();
      openedWindows.push(w);
      return w;
    }) as typeof window.open;
  });

  afterEach(() => {
    closeAllPanelWindows();
    window.open = originalOpen;
  });

  it('opens a popup window and records it in the snapshot', async () => {
    const kind = await openPanelWindow('clash');
    assert.equal(kind, 'popup');
    const snap = getPanelWindowsSnapshot();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].id, 'clash');
  });

  it('returns null when window.open is blocked by a popup blocker', async () => {
    window.open = (() => null) as unknown as typeof window.open;
    const kind = await openPanelWindow('clash');
    assert.equal(kind, null);
    assert.equal(getPanelWindowsSnapshot().length, 0);
  });

  it('focuses (and does not re-open) an already-popped-out panel', async () => {
    await openPanelWindow('clash');
    assert.equal(openedWindows.length, 1);
    const kind = await openPanelWindow('clash');
    assert.equal(kind, 'popup');
    assert.equal(openedWindows.length, 1, 'must reuse the existing window, not open a second one');
  });

  it('closePanelWindow removes only the closed entry — an unrelated open panel survives', async () => {
    await openPanelWindow('clash');
    await openPanelWindow('bcf');
    assert.equal(getPanelWindowsSnapshot().length, 2);

    closePanelWindow('clash');

    const snap = getPanelWindowsSnapshot();
    assert.equal(snap.length, 1, 'exactly one entry should remain');
    assert.equal(snap[0].id, 'bcf', 'the unrelated panel must survive the close');
    assert.equal(openedWindows[0].closed, true, 'the closed panel\'s OS window must actually be closed');
    assert.equal(openedWindows[1].closed, false, 'the surviving panel\'s OS window must NOT be closed');
  });

  it('closePanelWindow re-docks the panel in the store', async () => {
    await openPanelWindow('clash');
    assert.ok(getViewerStoreApi().getState().poppedOutIds.includes('clash'));
    closePanelWindow('clash');
    assert.ok(!getViewerStoreApi().getState().poppedOutIds.includes('clash'));
  });

  it('closeAllPanelWindows closes every open window and clears the map', async () => {
    await openPanelWindow('clash');
    await openPanelWindow('bcf');
    closeAllPanelWindows();
    assert.equal(getPanelWindowsSnapshot().length, 0);
    assert.ok(openedWindows.every((w) => w.closed));
  });

  it('subscribePanelWindows stops notifying after unsubscribe, while an unrelated listener keeps firing', async () => {
    let countA = 0;
    let countB = 0;
    const unsubA = subscribePanelWindows(() => {
      countA += 1;
    });
    const unsubB = subscribePanelWindows(() => {
      countB += 1;
    });

    await openPanelWindow('clash');
    assert.equal(countA, 1);
    assert.equal(countB, 1);

    unsubA();
    await openPanelWindow('bcf');
    assert.equal(countA, 1, 'unsubscribed listener must not fire again');
    assert.equal(countB, 2, 'the still-subscribed listener must keep firing');

    unsubB();
  });

  it('syncPanelWindowsTheme updates only windows that are still open', async () => {
    await openPanelWindow('clash');
    await openPanelWindow('bcf');
    openedWindows[0].close(); // simulate the child window having been closed out-of-band

    syncPanelWindowsTheme('dark');

    assert.equal(
      (openedWindows[1].document as unknown as { documentElement: { className: string } }).documentElement
        .className,
      'dark',
    );
    // The closed window's class must be left alone (guarded by `!win.closed`).
    assert.notEqual(
      (openedWindows[0].document as unknown as { documentElement: { className: string } }).documentElement
        .className,
      'dark',
    );
  });

  it('re-docking a panel via the store (poppedOutIds no longer includes it) closes its window', async () => {
    await openPanelWindow('clash');
    assert.equal(getPanelWindowsSnapshot().length, 1);

    getViewerStoreApi().getState().setPanelPoppedOut('clash', false);

    assert.equal(getPanelWindowsSnapshot().length, 0, 'store-driven re-dock must detach the window');
    assert.equal(openedWindows[0].closed, true);
  });
});
