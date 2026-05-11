/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../src/metrics.js';

describe('bucketed histograms', () => {
  it('counts observations into each bucket whose upper bound they meet', () => {
    const reg = new MetricsRegistry();
    const h = reg.bucketedHistogram('latency_ms', [10, 50, 100], 'request latency');

    h.observe(5);
    h.observe(40);
    h.observe(75);
    h.observe(200);

    const text = reg.render();
    expect(text).toContain('# TYPE latency_ms_bucket histogram');
    expect(text).toContain('latency_ms_bucket{le="10"} 1');
    expect(text).toContain('latency_ms_bucket{le="50"} 2');
    expect(text).toContain('latency_ms_bucket{le="100"} 3');
    expect(text).toContain('latency_ms_bucket{le="+Inf"} 4');
    expect(text).toContain('latency_ms_sum 320');
    expect(text).toContain('latency_ms_count 4');
  });

  it('respects label dimensions', () => {
    const reg = new MetricsRegistry();
    const h = reg.bucketedHistogram('rt', [1, 5], 'response time');
    h.observe(0.5, { route: 'a' });
    h.observe(3, { route: 'a' });
    h.observe(0.5, { route: 'b' });

    const text = reg.render();
    // Label keys are sorted alphabetically — `le` comes before `route`.
    expect(text).toMatch(/rt_bucket\{le="1",route="a"\} 1/);
    expect(text).toMatch(/rt_bucket\{le="5",route="a"\} 2/);
    expect(text).toMatch(/rt_bucket\{le="1",route="b"\} 1/);
  });

  it('throws when buckets is empty', () => {
    const reg = new MetricsRegistry();
    expect(() => reg.bucketedHistogram('x', [], 'help')).toThrow();
  });
});
