/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stopping the opt-in CPU trace never hangs and never reports a lossy trace as a measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { epochWindow, markTraceWindow, startCpuTraceSafe, stopCpuTrace } from './load-scoreboard-cputrace.mjs';

function fakeSession({ complete = { stream: 's' }, close = false, emit = true } = {}) {
  const cdp = new EventEmitter();
  cdp.detach = async () => {};
  cdp.send = async (method) => {
    if (method === 'Tracing.end') setTimeout(() => { if (close) cdp.emit('close'); else if (emit) cdp.emit('Tracing.tracingComplete', complete); }, 5);
    if (method === 'IO.read') return { data: JSON.stringify({ traceEvents: [] }), eof: true };
    return {};
  };
  return cdp;
}

test('a trace that never completes, or whose session closes, ends the wait with an error instead of hanging', async () => {
  const never = await stopCpuTrace(fakeSession({ emit: false }), { collectTimeoutMs: 50 });
  assert.equal(never.cpuTime.error, 'trace collection not finished within 50 ms');
  const closed = await stopCpuTrace(fakeSession({ close: true }), { collectTimeoutMs: 5000 });
  assert.equal(closed.cpuTime.error, 'CDP session closed before Tracing.tracingComplete');
});

test('a trace Chrome reports as lossy gives no CPU figure', async () => {
  const r = await stopCpuTrace(fakeSession({ complete: { stream: 's', dataLossOccurred: true } }), { collectTimeoutMs: 5000 });
  assert.equal(r.cpuTime.dataLoss, true);
  assert.equal(r.cpuTime.cpuMs, undefined);
});

test('session closes while Tracing.end is pending and that command rejects: cpuTime.error, and no unhandled rejection', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const cdp = new EventEmitter();
    cdp.detach = async () => {};
    cdp.send = (method) => (method === 'Tracing.end'
      ? new Promise((_, reject) => setTimeout(() => { cdp.emit('close'); reject(new Error('Target closed')); }, 5))
      : Promise.resolve({}));
    const r = await stopCpuTrace(cdp, { collectTimeoutMs: 5000 });
    assert.equal(typeof r.cpuTime.error, 'string');
    assert.equal(r.cpuTime.cpuMs, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let any stray rejection surface
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('Tracing.end that never settles: the wait returns after the timeout (fake timers)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = new EventEmitter();
  cdp.detach = async () => {};
  cdp.send = (method) => (method === 'Tracing.end' ? new Promise(() => {}) : Promise.resolve({}));
  const pending = stopCpuTrace(cdp); // default deadline (TRACE_COLLECT_TIMEOUT_MS)
  await Promise.resolve();
  t.mock.timers.tick(15000);
  const r = await pending;
  assert.equal(r.cpuTime.error, 'trace collection not finished within 15000 ms');
});

test('a failing CPU trace never fails the wall-clock sample: the load gets past a trace start that throws', async () => {
  const { browserSample } = await import('./load-scoreboard-browser.mjs');
  const { fakeBrowserSample } = await import('./load-scoreboard-fake-browser.mjs');
  // The fake context has no CDP: the trace start throws. The sample must still reach its open (the fake fails every
  // file open, in phase `cold`), never stop in `cold-shell` on the trace.
  const { result } = await fakeBrowserSample(browserSample, { cpuTrace: true });
  const error = result.lanes['browser-cold'].error;
  assert.equal(error.split(':')[0], 'cold');
  // The guarded steps return the failure for the measure only.
  const boom = { evaluate: async () => { throw new Error('page gone'); } };
  assert.equal((await startCpuTraceSafe({ newCDPSession: async () => { throw new Error('no CDP'); } }, boom)).error, 'trace start failed: no CDP');
  assert.equal(await markTraceWindow(boom, 1, 2, 1), 'trace marks failed: page gone');
  assert.equal(await epochWindow(boom, 1, 2), null);
});

test('an IO.read that never answers ends at the same single deadline; the sample keeps no CPU figure, not a hang', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cdp = new EventEmitter();
  cdp.detach = async () => {};
  cdp.send = (method) => {
    if (method === 'Tracing.end') { queueMicrotask(() => cdp.emit('Tracing.tracingComplete', { stream: 's' })); return Promise.resolve({}); }
    if (method === 'IO.read') return new Promise(() => {}); // never answers
    return Promise.resolve({});
  };
  const pending = stopCpuTrace(cdp, { collectTimeoutMs: 15000 });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(15000);
  const r = await pending;
  assert.equal(r.cpuTime.error, 'trace collection not finished within 15000 ms');
});

test('a Tracing.start that is never answered gives up after 5 s and the sample goes on untraced (fake timers)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let detached = false;
  const cdp = { send: () => new Promise(() => {}), detach: async () => { detached = true; } };
  const pending = startCpuTraceSafe({ newCDPSession: async () => cdp }, {});
  for (let i = 0; i < 3; i++) await Promise.resolve();
  t.mock.timers.tick(5000);
  assert.deepEqual(await pending, { error: 'trace start failed: no answer within 5000 ms' });
  assert.equal(detached, false); // the session's start never settled, so nothing was handed back to close
});
