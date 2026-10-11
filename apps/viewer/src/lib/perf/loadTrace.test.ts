/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLoadTracer, createPerfCounters } from '@ifc-lite/load-trace';
import { isPerfTraceRequested, loadTracer } from './loadTrace.js';
import { exposeLoadTrace } from './loadTraceEnabled.js';

interface ExposedTrace {
  latest(): { loadId: string; spans: Array<{ name: string }> } | null;
  tree(): Array<{ span: { name: string }; children: unknown[] }>;
  chromeTrace(): { traceEvents: Array<{ name: string; ph: string }> };
  sessionCounters(): Record<string, number>;
}

describe('viewer load trace (#6956)', () => {
  it('is opt-in: ?perfTrace=1 or the pre-boot benchmark flag', () => {
    assert.equal(isPerfTraceRequested('', undefined), false);
    assert.equal(isPerfTraceRequested('?perfTrace=0', undefined), false);
    assert.equal(isPerfTraceRequested('?geomWorkers=2&perfTrace=1', undefined), true);
    assert.equal(isPerfTraceRequested('', 1), true);
    assert.equal(isPerfTraceRequested('?perfTrace=1', 0), false, 'an explicit off flag beats the URL');
    assert.equal(isPerfTraceRequested('?perfTrace=1', false), false, 'an explicit off flag beats the URL');
    // No flag in this process, so the shared tracer is off and records nothing.
    assert.equal(loadTracer.enabled, false);
    assert.equal(loadTracer.startLoad('m').snapshot(), null);
  });

  it('publishes the span tree and its Chrome-trace export on the global', () => {
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const trace = tracer.startLoad('m1', { journey: 'J1' });
    const pool = trace.begin('geometry.pool');
    trace.record('shard.stitch', trace.start, trace.start + 1, undefined, pool);
    trace.end(pool);
    trace.milestone('geometry.firstVisible');
    trace.finish();

    const target: Record<string, unknown> = {};
    exposeLoadTrace(tracer, target);
    const api = target.__IFC_LITE_LOAD_TRACE__ as ExposedTrace;
    assert.equal(api.latest()?.loadId, 'm1');
    const tree = api.tree();
    const poolNode = tree.find((n) => n.span.name === 'geometry.pool');
    assert.equal(poolNode?.children.length, 1);
    const names = api.chromeTrace().traceEvents.filter((e) => e.ph === 'X').map((e) => e.name);
    assert.deepEqual(names, ['load', 'geometry.pool', 'shard.stitch', 'geometry.firstVisible']);
  });

  it('#6993 publishes session counter totals, including work outside every load window', () => {
    const counters = createPerfCounters();
    counters.enable();
    const tracer = createLoadTracer({ enabled: true, sink: null, counters });
    counters.add('gpu.deviceLost'); // lost at boot, before any load
    const trace = tracer.startLoad('m1');
    counters.add('react.commits', 3);
    trace.finish();

    const target: Record<string, unknown> = {};
    exposeLoadTrace(tracer, target, () => counters.read());
    const api = target.__IFC_LITE_LOAD_TRACE__ as ExposedTrace;
    assert.deepEqual(api.sessionCounters(), { 'gpu.deviceLost': 1, 'react.commits': 3 });
    assert.equal(tracer.latest()?.counters?.['gpu.deviceLost'], undefined, 'the per-load delta cannot see a boot-time loss');
    counters.add('react.commits', 2); // an interaction after the load
    assert.equal(api.sessionCounters()['react.commits'], 5);
  });
});
