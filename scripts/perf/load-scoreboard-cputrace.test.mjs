/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Stopping the opt-in CPU trace never hangs and never reports a lossy trace as a measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { stopCpuTrace } from './load-scoreboard-cputrace.mjs';

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
  const never = await stopCpuTrace(fakeSession({ emit: false }), { completeTimeoutMs: 50 });
  assert.match(never.cpuTime.error, /no Tracing.tracingComplete within 50 ms/);
  const closed = await stopCpuTrace(fakeSession({ close: true }), { completeTimeoutMs: 5000 });
  assert.match(closed.cpuTime.error, /session closed/);
});

test('a trace Chrome reports as lossy gives no CPU figure', async () => {
  const r = await stopCpuTrace(fakeSession({ complete: { stream: 's', dataLossOccurred: true } }), { completeTimeoutMs: 5000 });
  assert.equal(r.cpuTime.dataLoss, true);
  assert.equal(r.cpuTime.cpuMs, undefined);
});
