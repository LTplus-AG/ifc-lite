/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * StrictMode bridge teardown regression tests.
 *
 * React 19's <React.StrictMode> double-invokes effects in dev: mount ->
 * cleanup -> mount. `EmbedViewer`'s bridge-init effect used to guard only
 * the mount side with a ref; the cleanup unconditionally tore the bridge
 * down without resetting that guard, so the StrictMode remount saw the
 * guard already flipped and skipped re-init -- the postMessage listener
 * was gone for good, and the READY -> INIT -> INIT_ACK handshake could
 * never complete in dev.
 *
 * These tests wire `mountBridgeLifecycle`/`unmountBridgeLifecycle` (the
 * extracted guard used by EmbedViewer.tsx) around the REAL
 * `initBridge`/`destroyBridge` from ./handler.js, against a hand-rolled
 * `window` stub (same technique as handler.test.ts). A regression here
 * shows up as "the inbound listener is dead / a message goes unanswered",
 * not merely as an init call-count mismatch.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EMBED_SOURCE, PROTOCOL_VERSION } from '@ifc-lite/embed-protocol';
import { destroyBridge, initBridge } from './handler.js';
import { mountBridgeLifecycle, unmountBridgeLifecycle, type MountGuardRef } from './lifecycle.js';

// ---------------------------------------------------------------------------
// Test doubles (mirrors handler.test.ts's installWindow/makeCtx)
// ---------------------------------------------------------------------------

interface Posted {
  msg: any;
  targetOrigin: string;
}

interface FakeWindow {
  posted: Posted[];
  listenerCount: () => number;
  /**
   * `source` defaults to `win.parent` -- exactly what a real inbound
   * MessageEvent's `event.source` is for a message actually sent by the
   * host page, and what handler.ts's `event.source !== window.parent` check
   * requires. Omit it to model the legitimate parent; the lifecycle tests
   * here don't exercise forged senders (see handler.test.ts for that).
   */
  dispatch: (event: { data: unknown; origin: string; source?: unknown }) => void;
}

function installWindow(): FakeWindow {
  const posted: Posted[] = [];
  const listeners = new Set<(e: unknown) => void>();
  const win: any = {
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.add(fn);
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (type === 'message') listeners.delete(fn);
    },
  };
  win.parent = {
    postMessage: (msg: any, targetOrigin: string) => {
      posted.push({ msg, targetOrigin });
    },
  };
  (globalThis as any).window = win;
  return {
    posted,
    listenerCount: () => listeners.size,
    dispatch: (event) => {
      const withSource = { ...event, source: 'source' in event ? event.source : win.parent };
      for (const fn of [...listeners]) fn(withSource);
    },
  };
}

function makeState() {
  const calls: string[] = [];
  return {
    state: { showAllInAllModels: () => { calls.push('showAllInAllModels'); } },
    calls,
  };
}

function makeCtx(state: any) {
  return {
    getState: () => state,
    loadModelFromUrl: async () => ({ entities: 0, triangles: 0, vertices: 0 }),
    loadModelFromBuffer: async () => ({ entities: 0, triangles: 0, vertices: 0 }),
  };
}

const PARENT = 'https://host.example';

function cmd(type: string) {
  return { source: EMBED_SOURCE, version: PROTOCOL_VERSION, type };
}

afterEach(() => {
  destroyBridge();
  delete (globalThis as any).window;
});

// ---------------------------------------------------------------------------
// The regression itself
// ---------------------------------------------------------------------------

describe('StrictMode mount -> cleanup -> remount', () => {
  it('leaves the bridge ALIVE: listener registered and still handling inbound messages', async () => {
    const fw = installWindow();
    const { state, calls } = makeState();
    const ref: MountGuardRef = { current: false };

    const mount = () => mountBridgeLifecycle(ref, () => initBridge(makeCtx(state)));
    const unmount = () => unmountBridgeLifecycle(ref, () => destroyBridge());

    // Exactly what React 19 StrictMode does to every effect in dev.
    mount();
    unmount();
    mount();

    // Not just "was init called again" -- the listener must actually be
    // live and actually handle a message. This is what an asymmetric
    // guard (mount ref-checked, cleanup unconditional) breaks: mount() on
    // the second pass returns early because the guard was never reset, so
    // initBridge() never re-runs and no listener is registered.
    expect(fw.listenerCount()).toBe(1);

    fw.dispatch({ data: cmd('SHOW_ALL'), origin: PARENT });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toContain('showAllInAllModels');
  });

  it('returns the listener count to zero after every unmount and never exceeds one across repeated cycles', () => {
    const fw = installWindow();
    const { state } = makeState();
    const ref: MountGuardRef = { current: false };

    const mount = () => mountBridgeLifecycle(ref, () => initBridge(makeCtx(state)));
    const unmount = () => unmountBridgeLifecycle(ref, () => destroyBridge());

    mount();
    expect(fw.listenerCount()).toBe(1);
    unmount();
    expect(fw.listenerCount()).toBe(0);
    mount();
    expect(fw.listenerCount()).toBe(1);
    unmount();
    expect(fw.listenerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Bounding control: a normal single mount (no StrictMode) must still
// initialize exactly once. Without this, "just delete the guard entirely"
// would also pass the regression test above while reintroducing
// double-init / duplicate READY / duplicate listeners on every real mount.
// ---------------------------------------------------------------------------

describe('a single mount (no StrictMode cycling)', () => {
  it('initializes the bridge exactly once: one listener, one READY', () => {
    const fw = installWindow();
    const { state } = makeState();
    const ref: MountGuardRef = { current: false };
    let initCount = 0;

    mountBridgeLifecycle(ref, () => {
      initCount++;
      initBridge(makeCtx(state));
    });

    expect(initCount).toBe(1);
    expect(fw.listenerCount()).toBe(1);
    expect(fw.posted.filter((p) => p.msg.type === 'READY')).toHaveLength(1);
  });

  it('mounting twice in a row without an intervening unmount does not re-init', () => {
    const fw = installWindow();
    const { state } = makeState();
    const ref: MountGuardRef = { current: false };
    let initCount = 0;
    const mount = () => mountBridgeLifecycle(ref, () => {
      initCount++;
      initBridge(makeCtx(state));
    });

    mount();
    mount();

    expect(initCount).toBe(1);
    expect(fw.listenerCount()).toBe(1);
    expect(fw.posted.filter((p) => p.msg.type === 'READY')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Displacement: what the fix could break if it were careless.
// ---------------------------------------------------------------------------

describe('displacement checks', () => {
  it('destroyBridge() via unmountBridgeLifecycle on a never-mounted guard is a safe no-op', () => {
    const fw = installWindow();
    const ref: MountGuardRef = { current: false };
    let destroyCount = 0;

    unmountBridgeLifecycle(ref, () => {
      destroyCount++;
      destroyBridge();
    });

    expect(destroyCount).toBe(0);
    expect(fw.listenerCount()).toBe(0);
  });

  it('calling the real initBridge() twice directly does not duplicate the listener', () => {
    // Bypasses the ref guard entirely to check handler.ts's own behaviour:
    // onMessage is a single stable module-level function reference, so
    // addEventListener('message', onMessage) twice is deduped exactly like
    // native DOM semantics (same type + same listener reference).
    const fw = installWindow();
    const { state } = makeState();

    initBridge(makeCtx(state));
    initBridge(makeCtx(state));

    expect(fw.listenerCount()).toBe(1);
  });

  it('every addEventListener has exactly one matching removeEventListener: destroyBridge after a double initBridge clears it fully', () => {
    const fw = installWindow();
    const { state } = makeState();

    initBridge(makeCtx(state));
    initBridge(makeCtx(state));
    destroyBridge();

    expect(fw.listenerCount()).toBe(0);
  });
});
