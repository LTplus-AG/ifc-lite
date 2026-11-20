/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createStoragePersistence, estimateBrowserStorage } from './browser-storage';

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, 'storage', { configurable: true, value: undefined });
});

function mockStorage(storage: Partial<StorageManager>) {
  Object.defineProperty(navigator, 'storage', { configurable: true, value: storage });
}

// Discussion #10585: opening the notice must never prompt, and repeat requests
// must respect the browser's decision even after recreating the controller.
for (const granted of [true, false]) {
  test(`requests storage once when the browser ${granted ? 'grants' : 'denies'} persistence`, async () => {
    let prompts = 0;
    let persisted = false;
    mockStorage({
      persisted: async () => persisted,
      persist: async () => {
        prompts++;
        persisted = granted;
        return granted;
      },
      estimate: async () => ({ usage: 1024, quota: 4096 }),
    });

    const controller = createStoragePersistence();
    assert.deepEqual(await controller.read(), { state: 'bestEffort', canRequest: true });
    assert.deepEqual(await estimateBrowserStorage(), { usage: 1024, quota: 4096 });
    assert.equal(prompts, 0);

    const result = { state: granted ? 'persisted' : 'bestEffort', canRequest: false };
    assert.deepEqual(await Promise.all([controller.request(), controller.request()]), [result, result]);
    const reloaded = createStoragePersistence();
    assert.deepEqual(await reloaded.read(), result);
    assert.deepEqual(await reloaded.request(), result);
    assert.equal(prompts, 1);
  });
}

test('degrades without a StorageManager', async () => {
  const controller = createStoragePersistence();
  const unsupported = { state: 'unsupported', canRequest: false };
  assert.deepEqual(await controller.read(), unsupported);
  assert.deepEqual(await controller.request(), unsupported);
  assert.equal(await estimateBrowserStorage(), undefined);
});

test('guards storage access and rejected requests', async () => {
  const blocked = () => { throw new DOMException('Blocked', 'SecurityError'); };
  Object.defineProperty(navigator, 'storage', { configurable: true, get: blocked });
  const controller = createStoragePersistence();
  const unsupported = { state: 'unsupported', canRequest: false };
  assert.deepEqual(await controller.read(), unsupported);
  assert.equal(await estimateBrowserStorage(), undefined);

  let prompts = 0;
  mockStorage({
    persisted: async () => false,
    persist: async () => { prompts++; return blocked(); },
    estimate: async () => blocked(),
  });
  assert.deepEqual(await controller.request(), unsupported);
  assert.equal(await estimateBrowserStorage(), undefined);
  assert.equal((await createStoragePersistence().read()).canRequest, false);
  await controller.request();
  assert.equal(prompts, 1);
});

test('an iframe never accesses the StorageManager', async () => {
  const top = Object.getOwnPropertyDescriptor(window, 'top');
  let accessed = false;
  Object.defineProperty(window, 'top', { configurable: true, value: {} });
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    get() { accessed = true; throw new Error('StorageManager accessed from a frame'); },
  });
  try {
    const controller = createStoragePersistence();
    const unsupported = { state: 'unsupported', canRequest: false };
    assert.deepEqual(await controller.read(), unsupported);
    assert.deepEqual(await controller.request(), unsupported);
    assert.equal(await estimateBrowserStorage(), undefined);
    assert.equal(accessed, false);
  } finally {
    if (top) Object.defineProperty(window, 'top', top);
    else Reflect.deleteProperty(window, 'top');
  }
});
