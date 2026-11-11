/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Reopen lane, step 2: work no load waits for (the symbolic overlay parse) leaves
// the window between "model on screen" and "interactive".
import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '../../store/index.js';
import { runAfterLoadIdle } from './afterLoadIdle.js';

const idle: IdleRequestCallback[] = [];
const originalIdle = window.requestIdleCallback;
beforeEach(() => {
  idle.length = 0;
  window.requestIdleCallback = ((cb: IdleRequestCallback) => { idle.push(cb); return idle.length; }) as typeof window.requestIdleCallback;
  useViewerStore.setState({ loading: false, geometryStreamingActive: false });
});
afterEach(() => {
  window.requestIdleCallback = originalIdle;
  useViewerStore.setState({ loading: false, geometryStreamingActive: false });
});
const flushIdle = () => { for (const cb of idle.splice(0)) cb({ didTimeout: false, timeRemaining: () => 50 }); };

describe('runAfterLoadIdle', () => {
  it('runs at once when no load is in progress', () => {
    let runs = 0;
    runAfterLoadIdle(() => { runs++; });
    assert.equal(runs, 1);
  });

  it('waits for the load in progress to settle, then for an idle period', () => {
    useViewerStore.setState({ loading: true });
    let runs = 0;
    runAfterLoadIdle(() => { runs++; });
    useViewerStore.setState({ geometryStreamingActive: true });
    flushIdle();
    assert.equal(runs, 0, 'not while the load runs');
    useViewerStore.setState({ loading: false });
    assert.equal(runs, 0, 'not before the stream ends either');
    useViewerStore.setState({ geometryStreamingActive: false });
    assert.equal(runs, 0, 'settled: waits for an idle period');
    flushIdle();
    assert.equal(runs, 1);
  });

  it('runs nothing once cancelled', () => {
    useViewerStore.setState({ loading: true });
    let runs = 0;
    const cancel = runAfterLoadIdle(() => { runs++; });
    useViewerStore.setState({ loading: false });
    cancel();
    flushIdle();
    assert.equal(runs, 0);
  });
});
