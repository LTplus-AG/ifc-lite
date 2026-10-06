/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLoadTracer, NOOP_LOAD_TRACE } from '@ifc-lite/load-trace';
import { activeLoadTrace, modelLoadTrace, publishLoadTrace, tracePhaseOnce } from './activeLoadTrace.js';

describe('published load traces (#6979)', () => {
  it('ignores a disabled trace, so untraced loads leave every lookup a no-op', () => {
    const off = createLoadTracer({ enabled: false }).startLoad('untraced-model');
    publishLoadTrace('untraced-model', off);
    assert.equal(modelLoadTrace('untraced-model'), NOOP_LOAD_TRACE);
    assert.notEqual(activeLoadTrace(), off);
  });

  it('routes streaming work to the newest load and post-load work to the model that loaded', () => {
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const a = tracer.startLoad('model-a');
    const b = tracer.startLoad('model-b');
    publishLoadTrace('model-a', a);
    publishLoadTrace('model-b', b);
    assert.equal(activeLoadTrace(), b);
    assert.equal(modelLoadTrace('model-a'), a);
    assert.equal(modelLoadTrace('model-b'), b);
    assert.equal(modelLoadTrace('never-loaded'), NOOP_LOAD_TRACE);
  });

  it('hands out a post-load phase once per load, so later rebuilds are not recorded', () => {
    const tracer = createLoadTracer({ enabled: true, sink: null });
    const first = tracer.startLoad('model-c');
    assert.equal(tracePhaseOnce(first, 'bvh.build'), first);
    assert.equal(tracePhaseOnce(first, 'bvh.build'), NOOP_LOAD_TRACE);
    assert.equal(tracePhaseOnce(first, 'search.tier1'), first, 'phases are independent');
    const reload = tracer.startLoad('model-c');
    assert.equal(tracePhaseOnce(reload, 'bvh.build'), reload, 'a new load of the same model records again');
  });
});
