/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `ExtensionHostService` wires `runBundleTests`' `evaluateRegex` hook to
 * `regexWorkerClient.evaluate()` (a real `Worker`, #4482). An environment
 * with no `Worker` at all, or a CSP that blocks module workers, makes
 * `createRegexWorkerClient()`'s factory throw — and until #4505 that
 * rejection reached the caller as-is, so EVERY `expect.regex` matcher
 * failed, where before #4482 they all ran in-process. This suite runs in
 * Node, which has no global `Worker` either, so it exercises the real
 * fallback path rather than a simulated one: `evaluateRegexWithFallback`
 * must catch exactly that "worker didn't start" failure and fall back to
 * `defaultRegexEvaluator`, the same synchronous in-process check the
 * runner used before #4482 existed.
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
  /** Test-only reach into the private hook — see module doc. */
  evaluateRegex(pattern: string, text: string) {
    return (this as unknown as { evaluateRegexWithFallback: (p: string, t: string) => Promise<{ matched: boolean }> })
      .evaluateRegexWithFallback(pattern, text);
  }
}

describe('ExtensionHostService.evaluateRegexWithFallback (#4505 finding B)', () => {
  it('falls back to in-process evaluation when no Worker is available, instead of rejecting every check', async () => {
    const host = new TestHost();

    // Precondition: this test environment genuinely has no global
    // Worker, so the real regexWorkerClient really does fail to start
    // one — this is not a mock standing in for that failure.
    assert.equal(typeof (globalThis as { Worker?: unknown }).Worker, 'undefined');

    const matched = await host.evaluateRegex('hello.*42', 'hello world 42');
    assert.deepEqual(matched, { matched: true });

    const notMatched = await host.evaluateRegex('nope', 'hello world 42');
    assert.deepEqual(notMatched, { matched: false });
  });

  it('still rejects a genuinely invalid pattern through the fallback (does not swallow real errors)', async () => {
    const host = new TestHost();
    await assert.rejects(host.evaluateRegex('(', 'text'), SyntaxError);
  });
});
