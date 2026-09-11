/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionHostProvider.tsx` calls `service.dispose()` from an effect
 * cleanup on a `service` built via `useMemo(() => new ExtensionHostService(...), [bim])`
 * — an identity that survives React StrictMode's simulated
 * mount/cleanup/mount. `dispose()` used to latch the shared
 * `regexWorkerClient`'s `disposed` flag permanently, so the SECOND
 * `init()` call StrictMode triggers reused a client that would reject
 * every future `evaluate()` with "disposed" for the rest of the page
 * session — surfacing to the author as "invalid pattern" (#4505
 * finding C). `init()` now resets the client so a dispose()-then-init()
 * cycle on the SAME service instance doesn't poison it.
 */

import 'fake-indexeddb/auto';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBimContext } from '@ifc-lite/sdk';
import { ExtensionHostService } from './host.js';

class TestHost extends ExtensionHostService {
  constructor() {
    super({
      sdk: createBimContext({
        transport: {
          send: () => Promise.reject(new Error('SDK transport is not exercised by this test')),
          subscribe: () => () => {},
          close: () => {},
        },
      }),
    });
  }
  /** Test-only reach into the private client — see module doc. */
  regexClient() {
    return (this as unknown as { regexWorkerClient: { evaluate: (p: string, t: string) => Promise<unknown> } })
      .regexWorkerClient;
  }
}

describe('ExtensionHostService regex worker client survives a StrictMode-shaped dispose()+init() cycle', () => {
  it('does not leave the regex worker client permanently "disposed" after dispose() then init() on the same instance (#4505 finding C)', async () => {
    const host = new TestHost();

    await host.dispose();
    // Precondition: dispose() really did latch the client (otherwise this
    // test would pass for the wrong reason).
    await assert.rejects(host.regexClient().evaluate('a', 'a'), /disposed/i);

    // StrictMode's second mount effect calls init() again on the SAME
    // service instance (useMemo identity is stable) — never reconstructs
    // ExtensionHostService.
    await host.init();

    // The rejection reason must have changed from "disposed" — this repo
    // has no global `Worker`, so the un-poisoned client now genuinely
    // attempts to start one and rejects for THAT reason instead. Any
    // "disposed" rejection here means the reset in init() didn't run.
    await assert.rejects(
      host.regexClient().evaluate('a', 'a'),
      (err: unknown) => err instanceof Error && !/disposed/i.test(err.message),
    );
  });
});
