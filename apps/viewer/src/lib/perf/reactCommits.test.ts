/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffCounters, perfCounters } from '@ifc-lite/load-trace';
import { installReactCommitCounter } from './reactCommits.js';

perfCounters.enable();

describe('React commit counter (#6957)', () => {
  it('installs a DevTools hook that react-dom accepts and counts its commits', async () => {
    const target: Record<string, unknown> = {};
    installReactCommitCounter(target);
    // react-dom reads the global hook when it loads, so install it on the real
    // global first and only then load react-dom (the bootstrap import order).
    const g = globalThis as Record<string, unknown>;
    const saved = g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = target.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    try {
      await import('../../test/setup-dom.js');
      const React = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { flushSync } = await import('react-dom');
      (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false; // plain flushSync, no act()
      const before = perfCounters.read();
      const root = createRoot(document.createElement('div'));
      flushSync(() => root.render(React.createElement('span', null, 'a')));
      flushSync(() => root.render(React.createElement('span', null, 'b')));
      flushSync(() => root.unmount());
      assert.equal(diffCounters(perfCounters.read(), before)['react.commits'], 3);
    } finally {
      g.__REACT_DEVTOOLS_GLOBAL_HOOK__ = saved;
    }
  });

  it('chains onto an existing DevTools hook instead of replacing it', () => {
    const seen: unknown[] = [];
    const hook = { supportsFiber: true, onCommitFiberRoot: (...a: unknown[]) => seen.push(a) };
    const target: Record<string, unknown> = { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook };
    const before = perfCounters.read();
    installReactCommitCounter(target);
    assert.equal(target.__REACT_DEVTOOLS_GLOBAL_HOOK__, hook);
    hook.onCommitFiberRoot(1, 'root');
    assert.deepEqual(seen, [[1, 'root']]);
    assert.equal(diffCounters(perfCounters.read(), before)['react.commits'], 1);
  });
});
