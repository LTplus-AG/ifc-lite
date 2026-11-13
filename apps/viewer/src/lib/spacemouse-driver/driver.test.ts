/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpaceMouseDriver } from './driver.js';
import type { DriverCamera, SdkConstructor, SdkInstance } from './types.js';

/** A canvas stand-in that records listeners. */
function fakeCanvas() {
  const listeners = new Map<string, Set<EventListener>>();
  const c = {
    tabIndex: -1,
    focused: 0,
    addEventListener: (t: string, f: EventListener) => (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
    removeEventListener: (t: string, f: EventListener) => listeners.get(t)?.delete(f),
    focus: () => {
      c.focused++;
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    fire: (t: string, e: object = {}) => listeners.get(t)?.forEach((f) => f(e as Event)),
  };
  return c;
}

function makeCam(canvas = fakeCanvas()) {
  const cam: DriverCamera = {
    canvas: canvas as unknown as HTMLElement,
    getPose: () => ({ pos: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0] }),
    setPose: () => {},
    getFov: () => 1,
    setFov: () => {},
    getAspect: () => 2,
    getBounds: () => null,
    requestRender: () => {},
  };
  return { cam, canvas };
}

/** A fake SDK: `behaviour` decides what the "driver" does when connect() is called. */
function fakeSdk(behaviour: (client: Record<string, (...a: unknown[]) => void>, lib: SdkInstance) => void) {
  const state = { loads: 0, instances: [] as FakeLib[] };
  class FakeLib implements SdkInstance {
    client: Record<string, (...a: unknown[]) => void>;
    created: { view: unknown; appName: string } | null = null;
    deleted = 0;
    closed = 0;
    session = { close: () => void this.closed++ };
    constructor(client: object) {
      this.client = client as Record<string, (...a: unknown[]) => void>;
      state.instances.push(this);
    }
    connect() {
      behaviour(this.client, this);
      return 1;
    }
    create3dmouse(view: unknown, appName: string) {
      this.created = { view, appName };
      queueMicrotask(() => this.client.on3dmouseCreated());
    }
    delete3dmouse() {
      this.deleted++;
    }
  }
  const loadSdk = async () => {
    state.loads++;
    return { default: FakeLib as unknown as SdkConstructor };
  };
  return { state, loadSdk };
}

test('nothing is loaded until connect() is called (opt-in, lazy)', () => {
  const sdk = fakeSdk(() => {});
  new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  assert.equal(sdk.state.loads, 0);
});

test('connects: the SDK gets the app name and the view, and connect() resolves true', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const { cam, canvas } = makeCam();
  const d = new SpaceMouseDriver(cam, { appName: 'My viewer', loadSdk: sdk.loadSdk });
  let status = 0;
  d.onStatus = () => status++;
  assert.equal(await d.connect(500), true);
  assert.equal(d.connected, true);
  assert.equal(d.lastError, undefined);
  assert.equal(status, 1);
  assert.equal(sdk.state.instances[0].created?.appName, 'My viewer');
  assert.equal(sdk.state.instances[0].created?.view, canvas);
  assert.equal(canvas.tabIndex, 0, 'the view is made focusable');
});

test('pointer-down focuses the view (the driver moves the focused view)', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const { cam, canvas } = makeCam();
  await new SpaceMouseDriver(cam, { appName: 'T', loadSdk: sdk.loadSdk }).connect(500);
  canvas.fire('pointerdown');
  assert.equal(canvas.focused, 1);
});

test('the driver not running: resolves false with a reason, never throws', async () => {
  const sdk = fakeSdk(() => {}); // the driver never answers
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  assert.equal(await d.connect(30), false);
  assert.equal(d.connected, false);
  assert.match(d.lastError ?? '', /not reachable/);
});

test('a driver that starts later is still picked up (onStatus fires)', async () => {
  let late: (() => void) | undefined;
  const sdk = fakeSdk((client) => {
    late = () => client.onConnect();
  });
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  let status = 0;
  d.onStatus = () => status++;
  assert.equal(await d.connect(20), false);
  late!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(d.connected, true);
  assert.equal(status, 1);
  assert.equal(d.lastError, undefined);
});

test('a refused connection resolves false with the reason', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onDisconnect('refused')));
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  assert.equal(await d.connect(500), false);
  assert.match(d.lastError ?? '', /refused/);
});

test('an SDK that cannot be loaded resolves false and can be retried', async () => {
  let fail = true;
  const good = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const d = new SpaceMouseDriver(makeCam().cam, {
    appName: 'T',
    loadSdk: async () => {
      if (fail) throw new Error('module not found');
      return good.loadSdk();
    },
  });
  assert.equal(await d.connect(200), false);
  assert.match(d.lastError ?? '', /module not found/);
  fail = false;
  assert.equal(await d.connect(500), true);
});

test('connect() twice reuses one SDK instance', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  await Promise.all([d.connect(500), d.connect(500)]);
  assert.equal(await d.connect(500), true);
  assert.equal(sdk.state.instances.length, 1);
  assert.equal(sdk.state.loads, 1);
});

test('disconnect() releases the device, closes the session and removes the listeners', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const { cam, canvas } = makeCam();
  const d = new SpaceMouseDriver(cam, { appName: 'T', loadSdk: sdk.loadSdk });
  await d.connect(500);
  assert.ok(canvas.count() > 0);
  let status = 0;
  d.onStatus = () => status++;
  d.disconnect();
  const lib = sdk.state.instances[0];
  assert.equal(lib.deleted, 1);
  assert.equal(lib.closed, 1);
  assert.equal(canvas.count(), 0);
  assert.equal(d.connected, false);
  assert.equal(status, 1);
  assert.equal(await d.connect(500), true, 'reconnecting after a disconnect works');
  assert.equal(sdk.state.instances.length, 2);
});

test('the driver going away after a connection flips `connected` and notifies', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  await d.connect(500);
  let status = 0;
  d.onStatus = () => status++;
  sdk.state.instances[0].client.onDisconnect('closed');
  assert.equal(d.connected, false);
  assert.equal(status, 1);
});

test('the debug flag is passed to the SDK through its global', async () => {
  const seen: unknown[] = [];
  const sdk = fakeSdk((client) => {
    seen.push((globalThis as Record<string, unknown>)._3DCONNEXION_DEBUG);
    queueMicrotask(() => client.onConnect());
  });
  await new SpaceMouseDriver(makeCam().cam, { appName: 'T', debug: true, loadSdk: sdk.loadSdk }).connect(500);
  await new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk }).connect(500);
  assert.deepEqual(seen, [true, false]);
});

test('the Fit key reaches onFit through the whole stack', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  let fits = 0;
  d.onFit = () => fits++;
  await d.connect(500);
  sdk.state.instances[0].client.setKeyPress(0x1f);
  assert.equal(fits, 1);
});

/** A loader whose SDK load is held until `release()` (or failed with `fail()`), to race connect() against disconnect(). */
function deferredLoader(sdk: ReturnType<typeof fakeSdk>) {
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const loadSdk = () =>
    new Promise<{ default: SdkConstructor }>((resolve, reject) => {
      pending.push({ resolve: () => void sdk.loadSdk().then(resolve), reject });
    });
  return { loadSdk, pending };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test('disconnect() during the SDK load cancels the start: no SDK connection, listeners or late status', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const loader = deferredLoader(sdk);
  const { cam, canvas } = makeCam();
  const d = new SpaceMouseDriver(cam, { appName: 'T', loadSdk: loader.loadSdk });
  let status = 0;
  d.onStatus = () => status++;
  const result = d.connect(500);
  d.disconnect();
  assert.equal(await result, false, 'the pending connect() settles false at disconnect');
  loader.pending[0].resolve();
  await tick();
  assert.equal(sdk.state.instances.length, 0, 'no SDK client was constructed');
  assert.equal(canvas.count(), 0, 'no view listeners were installed');
  assert.equal(d.connected, false);
  assert.equal(status, 0);
});

test('a cancelled SDK load that fails later does not report its error', async () => {
  const sdk = fakeSdk(() => {});
  const loader = deferredLoader(sdk);
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: loader.loadSdk });
  const result = d.connect(500);
  d.disconnect();
  assert.equal(await result, false);
  loader.pending[0].reject(new Error('stale failure'));
  await tick();
  assert.equal(d.lastError, undefined);
});

test('a new connect() before the old load completes: the old load cannot overwrite the new session', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const loader = deferredLoader(sdk);
  const { cam, canvas } = makeCam();
  const d = new SpaceMouseDriver(cam, { appName: 'T', loadSdk: loader.loadSdk });
  const first = d.connect(500);
  d.disconnect();
  assert.equal(await first, false);
  const second = d.connect(500);
  assert.equal(loader.pending.length, 2, 'the new connect() starts its own load');

  loader.pending[1].resolve(); // the new session's load finishes first
  assert.equal(await second, true);
  const listeners = canvas.count();
  loader.pending[0].resolve(); // then the stale one
  await tick();

  assert.equal(sdk.state.instances.length, 1, 'only the new session constructed an SDK client');
  assert.equal(canvas.count(), listeners, 'the stale session added no listeners');
  assert.equal(d.connected, true);
  d.disconnect();
  assert.equal(sdk.state.instances[0].deleted, 1, 'disconnect() releases the live session');
  assert.equal(canvas.count(), 0);
});

test('callbacks from a disconnected session are ignored after reconnecting', async () => {
  const sdk = fakeSdk((client) => queueMicrotask(() => client.onConnect()));
  const d = new SpaceMouseDriver(makeCam().cam, { appName: 'T', loadSdk: sdk.loadSdk });
  await d.connect(500);
  d.disconnect();
  assert.equal(await d.connect(500), true);
  const [old, current] = sdk.state.instances;
  old.created = null;
  current.created = null;
  let status = 0;
  d.onStatus = () => status++;
  old.client.onDisconnect('old session');
  assert.equal(d.connected, true, 'the old session cannot mark the live one disconnected');
  assert.equal(d.lastError, undefined);
  old.client.onConnect();
  await tick();
  assert.equal(old.created, null, 'the old session cannot re-attach the device');
  assert.equal(current.created, null, 'nor attach it through the live session');
  assert.equal(status, 0);
});
