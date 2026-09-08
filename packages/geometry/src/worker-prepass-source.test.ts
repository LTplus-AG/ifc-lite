/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { canReuseWorkerSource } from './worker-prepass-source.js';

describe('source isolation across worker requests (#3989)', () => {
  it.each([
    { scenario: 'aborted scan A then stream B', installed: 'load-a', requested: 'load-b', allowed: false },
    { scenario: 'aborted scan A then older unversioned stream', installed: 'load-a', requested: undefined, allowed: false },
    { scenario: 'two unversioned requests', installed: undefined, requested: undefined, allowed: false },
    { scenario: 'styles before any source installation', installed: undefined, requested: 'load-a', allowed: false },
    { scenario: 'same load across cloned scan/style/finalize messages', installed: 'load-a', requested: 'load-a', allowed: true },
  ])('$scenario', ({ installed, requested, allowed }) => {
    // Protocol invariant: only an explicit same-load lease permits reuse.
    // Missing tokens must not compare equal and accidentally authorize stale
    // bytes from a previous request that never reached stream-start.
    const delivered = structuredClone({ sourceSessionId: requested });
    expect(canReuseWorkerSource(installed, delivered.sourceSessionId)).toBe(allowed);
  });
});
