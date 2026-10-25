// SPDX-License-Identifier: MPL-2.0
// #7955: exercise the real WASM clock import. No production test-clock feature.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export function exerciseInspectionClock(run, options, entry, source, boundary) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const install = value => Object.defineProperty(globalThis, 'performance', { configurable: true, value });
  const restore = () => Object.defineProperty(globalThis, 'performance', original);
  const preparation = [];
  try {
    // #7955 A0P-R3: input transfer is complete at boundary(). Observe memory
    // before Rust preparation and at its FIRST production clock import. Growing
    // irrelevant records force real source/index backing growth after that
    // sample. Invalid options/clock must refuse without that growth.
    const intent = { ...options, maxWork: '1000000', maxBytes: '134217728' };
    for (const records of [0, 2000, 100000]) {
      const extra = Array.from({ length: records }, (_, i) => `#${1000 + i}=IFCCARTESIANPOINT((0.,0.,0.));`).join('');
      const text = source.replace('ENDSEC;END-ISO', `${extra}ENDSEC;END-ISO`);
      let samples, first;
      const sample = () => {
        if (++samples === 1) {
          first = { bytes: boundary().memory.buffer.byteLength, milliseconds: performance.now() - boundary().time };
        }
        return performance.now();
      };
      for (const control of ['invalid_options', 'invalid_clock', 'valid']) {
        samples = 0; first = undefined;
        install({ now() { const now = sample(); return control === 'invalid_clock' ? NaN : now; } });
        if (control === 'valid') {
          assert.equal(run(text, intent).outcome.kind, 'requires_numerical_evaluation');
        } else {
          assert.throws(() => run(text, control === 'invalid_options' ? { ...intent, extra: true } : intent),
            entry(control === 'invalid_options' ? 'INVALID_OPTIONS' : 'DEADLINE_EXCEEDED'));
        }
        assert.ok(first, 'Raw entry samples the production clock even for invalid options');
        assert.equal(first.bytes, boundary().bytes, 'First production clock precedes source-preparation growth');
        const growth = boundary().memory.buffer.byteLength - boundary().bytes;
        if (control !== 'valid') assert.equal(growth, 0, 'Refusal precedes source-sized preparation');
        if (control === 'valid' && records === 100000) assert.ok(growth > 0, 'Large source exercises actual memory growth');
        preparation.push({ records, control, firstSampleMs: first.milliseconds, firstSampleGrowth: first.bytes - boundary().bytes, growth });
      }
    }
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
  return preparation;
}
