/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * blob-store.ts had zero test coverage. `createSharedBlobStore` is a small
 * factory, but its branch (server vs. local-only) picks between two entirely
 * different storage backends, and its `ws → http` base-URL rewrite has to
 * survive the exact URL shapes the collab-server config accepts (a bare
 * `ws://` origin, a `wss://` origin, and one with a trailing slash — the
 * comment in `blob-upload.ts`'s sibling module notes a trailing slash used to
 * produce a double-slashed URL once a path is appended).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createSharedBlobStore } from './blob-store.js';

/** A stand-in for `typeof import('@ifc-lite/collab')`, recording constructor calls. */
function fakeCollabModule() {
  const httpCalls: unknown[] = [];
  let indexedDbCalls = 0;
  const module = {
    HttpBlobStore: class {
      opts: unknown;
      constructor(opts: unknown) {
        this.opts = opts;
        httpCalls.push(opts);
      }
    },
    createIndexedDbBlobStore: async () => {
      indexedDbCalls++;
      return { kind: 'indexeddb' } as never;
    },
  };
  return { module, httpCalls, callCount: () => indexedDbCalls };
}

describe('createSharedBlobStore', () => {
  it('uses IndexedDB in local-only mode (no server URL)', async () => {
    const { module, httpCalls, callCount } = fakeCollabModule();
    const store = await createSharedBlobStore(module as never, null);
    assert.equal(httpCalls.length, 0, 'must not construct an HTTP store with no server');
    assert.equal(callCount(), 1);
    assert.deepEqual(store, { kind: 'indexeddb' });
  });

  it('uses HttpBlobStore against the server, converting ws(s):// to http(s)://', async () => {
    const { module, httpCalls } = fakeCollabModule();
    await createSharedBlobStore(module as never, 'wss://collab.example.test', 'tok-123');
    assert.equal(httpCalls.length, 1);
    assert.deepEqual(httpCalls[0], { baseUrl: 'https://collab.example.test', token: 'tok-123' });
  });

  it('converts plain ws:// (not just wss://) to http://', async () => {
    const { module, httpCalls } = fakeCollabModule();
    await createSharedBlobStore(module as never, 'ws://localhost:1234');
    assert.equal((httpCalls[0] as { baseUrl: string }).baseUrl, 'http://localhost:1234');
  });

  it('strips a trailing slash so the /blobs route does not get a double slash', async () => {
    const { module, httpCalls } = fakeCollabModule();
    await createSharedBlobStore(module as never, 'wss://collab.example.test/');
    assert.equal((httpCalls[0] as { baseUrl: string }).baseUrl, 'https://collab.example.test');
  });

  it('passes an undefined token through when none is given', async () => {
    const { module, httpCalls } = fakeCollabModule();
    await createSharedBlobStore(module as never, 'wss://collab.example.test');
    assert.equal((httpCalls[0] as { token?: string }).token, undefined);
  });
});
