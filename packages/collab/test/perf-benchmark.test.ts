/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import {
  measureColdLoad,
  measureSingleAttrUpdateBytes,
  runPerfBenchmarks,
} from '../src/perf/benchmark.js';

describe('perf benchmark suite', () => {
  it('single-attr update fits the §15 budget (<200 bytes)', () => {
    const r = measureSingleAttrUpdateBytes(200);
    expect(r.value).toBeLessThanOrEqual(200);
    expect(r.ok).toBe(true);
  });

  it('cold load on 1k-entity fixture is well under 3s', () => {
    const r = measureColdLoad(1000, 3000);
    expect(r.unit).toBe('ms');
    expect(r.value).toBeLessThanOrEqual(3000);
    expect(r.ok).toBe(true);
  });

  it('runPerfBenchmarks returns at least the lightweight benchmarks', () => {
    const results = runPerfBenchmarks();
    const names = results.map((r) => r.name);
    expect(names).toContain('single-attr-update-bytes');
    expect(names.some((n) => n.startsWith('cold-load-'))).toBe(true);
    for (const r of results) expect(r.ok).toBe(true);
  });
});
