// SPDX-License-Identifier: MPL-2.0
// #7955: exercise the real WASM clock import. No production test-clock feature.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export function exerciseInspectionClock(run, options, entry) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const install = value => Object.defineProperty(globalThis, 'performance', { configurable: true, value });
  const restore = () => Object.defineProperty(globalThis, 'performance', original);
  try {
    // Introduce a real synchronous host delay between two REAL monotonic
    // readings. It covers the captured-start contract without hoping a fixture
    // happens to take >10ms on every CPU, or supplying fabricated elapsed time.
    let calls = 0;
    const wait = new Int32Array(new SharedArrayBuffer(4));
    install({ now() {
      if (++calls === 2) Atomics.wait(wait, 0, 0, 30);
      return performance.now();
    } });
    assert.throws(() => run(undefined, { ...options, deadlineMs: '10' }), entry('DEADLINE_EXCEEDED'));
    assert.ok(calls >= 2);
    for (const clock of [undefined, { now() { throw new Error('host clock unavailable'); } },
      { now: () => NaN }, { now: () => Infinity }, { now: () => -1 }]) {
      install(clock);
      assert.throws(() => run(), entry('DEADLINE_EXCEEDED'));
    }
    calls = 0;
    install({ now: () => ++calls === 1 ? performance.now() : 0 });
    assert.throws(() => run(), entry('DEADLINE_EXCEEDED'), 'Regressing clock fails closed');
  } finally { restore(); }
  assert.equal(run().outcome.kind, 'requires_numerical_evaluation', 'New request with real clock recovers');
}
