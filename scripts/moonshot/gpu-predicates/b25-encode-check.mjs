// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// ---- phase: encodecheck (pure Node, no browser, no GPU) --------------------
//
// Proves encodeTestFast (BigInt-free) is word-for-word identical to the
// trusted BigInt encoder encodeTest over random + adversarial inputs.
export async function runEncodeCheck() {
  const ref = await import('./reference.mjs');
  const report = { phase: 'encodecheck', generatedAt: new Date().toISOString() };

  function compareOne(coords) {
    const a = ref.encodeTest(coords);
    const b = ref.encodeTestFast(coords);
    if (a.valid !== b.valid) return `valid mismatch: ${a.valid} vs ${b.valid}`;
    if ((a.D ?? null) !== (b.D ?? null)) return `D mismatch: ${a.D} vs ${b.D}`;
    if ((a.eMin ?? null) !== (b.eMin ?? null)) return `eMin mismatch: ${a.eMin} vs ${b.eMin}`;
    if (a.valid) {
      for (let i = 0; i < a.words.length; i++) {
        if (a.words[i] !== b.words[i]) return `word[${i}] mismatch: ${a.words[i]} vs ${b.words[i]}`;
      }
    }
    return null;
  }

  const rand = (mag) => (Math.random() * 2 - 1) * mag;
  const specialPool = [
    0, -0, 1, -1, Number.MIN_VALUE, -Number.MIN_VALUE, 5e-324, 2.2250738585072014e-308,
    1.7976931348623157e308, -1.7976931348623157e308, 1e-300, 1e300, Math.PI, -Math.E,
    Math.pow(2, -1000), Math.pow(2, 1000), NaN, Infinity, -Infinity, 6755399441055744.0,
  ];

  const sets = [];
  {
    const tests = [];
    for (let i = 0; i < 200000; i++) tests.push(Array.from({ length: 12 }, () => rand(1000)));
    sets.push(['random_mag1e3_2e5', tests]);
  }
  {
    const tests = [];
    for (let i = 0; i < 50000; i++) tests.push(Array.from({ length: 12 }, () => rand(1e9)));
    sets.push(['random_mag1e9_5e4', tests]);
  }
  {
    const tests = [];
    for (let i = 0; i < 50000; i++) tests.push(Array.from({ length: 12 }, () => rand(1e-6)));
    sets.push(['random_mag1e-6_5e4', tests]);
  }
  {
    // adversarial: mixtures drawn from the special pool (zeros, subnormals,
    // DBL_MAX, NaN/Inf, exact powers of two) plus wide-spread constructions
    // that straddle the D_MAX boundary.
    const tests = [];
    for (let i = 0; i < 30000; i++) {
      tests.push(
        Array.from({ length: 12 }, () =>
          Math.random() < 0.5 ? specialPool[(Math.random() * specialPool.length) | 0] : rand(1000)
        )
      );
    }
    for (const D of [98, 99, 100, 101, 102, 150, 1074]) {
      const tiny = Math.pow(2, -D);
      tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, tiny, tiny, 0]);
      tests.push([0, 0, 0, 1, 0, 0, 0, 1, 0, -tiny, tiny, 0]);
    }
    tests.push(new Array(12).fill(0));
    tests.push(new Array(12).fill(-0));
    sets.push(['adversarial_specials_3e4', tests]);
  }

  const results = [];
  for (const [label, tests] of sets) {
    let mismatches = 0;
    let firstMismatch = null;
    const t0 = performance.now();
    for (const t of tests) {
      const err = compareOne(t);
      if (err !== null) {
        mismatches++;
        if (!firstMismatch) firstMismatch = { coords: t, err };
      }
    }
    const ms = performance.now() - t0;
    results.push({ label, cases: tests.length, mismatches, firstMismatch, ms });
  }

  // micro-benchmark the two encoders on identical data (single thread).
  {
    const n = 200000;
    const flat = new Float64Array(n * 12);
    for (let i = 0; i < flat.length; i++) flat[i] = rand(1000);
    let t0 = performance.now();
    for (let i = 0; i < n; i++) ref.encodeTest(flat.subarray(i * 12, i * 12 + 12));
    const slowMs = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < n; i++) ref.encodeTestFast(flat.subarray(i * 12, i * 12 + 12));
    const fastMs = performance.now() - t0;
    report.encoderMicrobench = { n, bigIntEncodeMs: slowMs, fastEncodeMs: fastMs, ratio: slowMs / fastMs };
  }

  report.results = results;
  report.totalMismatches = results.reduce((s, r) => s + r.mismatches, 0);
  return report;
}
