/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Lightweight metrics registry (spec §15 §14.4).
 *
 * Prometheus-text-format compatible — apps can scrape `/metrics` and
 * point Grafana / Datadog / etc. at it. Metric types are intentionally
 * minimal:
 *   - counters (monotonic)
 *   - gauges    (set/inc/dec to any value)
 *   - histograms via simple sum + count (we don't ship buckets — those
 *     come in v0.5+)
 *
 * Built dependency-free so we can swap for prom-client later without an
 * API churn.
 */

export type LabelValues = Record<string, string>;

interface MetricEntry {
  type: 'counter' | 'gauge' | 'histogram-sum' | 'histogram-count' | 'histogram-bucket';
  help: string;
  values: Map<string, number>;
  /** Bucket upper bounds for histograms (sorted ascending). */
  buckets?: readonly number[];
}

function labelKey(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, MetricEntry>();

  private ensure(name: string, type: MetricEntry['type'], help: string): MetricEntry {
    let m = this.metrics.get(name);
    if (!m) {
      m = { type, help, values: new Map() };
      this.metrics.set(name, m);
    }
    return m;
  }

  /** Register or fetch a counter. Counters are monotonic (only `inc`). */
  counter(name: string, help: string) {
    const m = this.ensure(name, 'counter', help);
    return {
      inc: (n = 1, labels: LabelValues = {}) => {
        const key = labelKey(labels);
        m.values.set(key, (m.values.get(key) ?? 0) + n);
      },
      get: (labels: LabelValues = {}) => m.values.get(labelKey(labels)) ?? 0,
    };
  }

  /** Register or fetch a gauge. Gauges can move in any direction. */
  gauge(name: string, help: string) {
    const m = this.ensure(name, 'gauge', help);
    return {
      set: (value: number, labels: LabelValues = {}) => {
        m.values.set(labelKey(labels), value);
      },
      inc: (n = 1, labels: LabelValues = {}) => {
        const key = labelKey(labels);
        m.values.set(key, (m.values.get(key) ?? 0) + n);
      },
      dec: (n = 1, labels: LabelValues = {}) => {
        const key = labelKey(labels);
        m.values.set(key, (m.values.get(key) ?? 0) - n);
      },
      get: (labels: LabelValues = {}) => m.values.get(labelKey(labels)) ?? 0,
    };
  }

  /**
   * Tiny histogram: tracks `sum` and `count`. Apps can compute average
   * client-side. Real bucketed histograms are also available via
   * `bucketedHistogram(name, buckets, help)`.
   */
  histogram(name: string, help: string) {
    const sumName = `${name}_sum`;
    const countName = `${name}_count`;
    const sum = this.ensure(sumName, 'histogram-sum', help);
    const count = this.ensure(countName, 'histogram-count', help);
    return {
      observe: (value: number, labels: LabelValues = {}) => {
        const key = labelKey(labels);
        sum.values.set(key, (sum.values.get(key) ?? 0) + value);
        count.values.set(key, (count.values.get(key) ?? 0) + 1);
      },
      mean: (labels: LabelValues = {}) => {
        const key = labelKey(labels);
        const c = count.values.get(key) ?? 0;
        if (c === 0) return 0;
        return (sum.values.get(key) ?? 0) / c;
      },
    };
  }

  /**
   * Prometheus-style bucketed histogram. `buckets` are upper bounds
   * (e.g. `[5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000]`). Each
   * observation increments every bucket whose upper bound it doesn't
   * exceed, plus `sum` and `count`. Render output uses the
   * conventional `<name>_bucket{le="<bound>"}` labels.
   */
  bucketedHistogram(name: string, buckets: readonly number[], help: string) {
    if (buckets.length === 0) {
      throw new Error(`@ifc-lite/collab-server: bucketedHistogram requires at least one bucket`);
    }
    const sortedBuckets = [...buckets].sort((a, b) => a - b);
    const sumName = `${name}_sum`;
    const countName = `${name}_count`;
    const bucketName = `${name}_bucket`;
    const sum = this.ensure(sumName, 'histogram-sum', help);
    const count = this.ensure(countName, 'histogram-count', help);
    const bucketEntry = this.ensure(bucketName, 'histogram-bucket', help);
    bucketEntry.buckets = sortedBuckets;

    return {
      observe: (value: number, labels: LabelValues = {}) => {
        const key = labelKey(labels);
        sum.values.set(key, (sum.values.get(key) ?? 0) + value);
        count.values.set(key, (count.values.get(key) ?? 0) + 1);
        for (const b of sortedBuckets) {
          if (value <= b) {
            const bucketKey = labelKey({ ...labels, le: String(b) });
            bucketEntry.values.set(bucketKey, (bucketEntry.values.get(bucketKey) ?? 0) + 1);
          }
        }
        // +Inf bucket — every observation counts.
        const infKey = labelKey({ ...labels, le: '+Inf' });
        bucketEntry.values.set(infKey, (bucketEntry.values.get(infKey) ?? 0) + 1);
      },
      buckets: sortedBuckets,
    };
  }

  /** Render the full registry as Prometheus text format. */
  render(): string {
    const lines: string[] = [];
    for (const [name, m] of this.metrics) {
      lines.push(`# HELP ${name} ${m.help}`);
      const renderedType =
        m.type === 'counter'
          ? 'counter'
          : m.type === 'histogram-bucket'
            ? 'histogram'
            : 'gauge';
      lines.push(`# TYPE ${name} ${renderedType}`);
      if (m.values.size === 0) {
        lines.push(`${name} 0`);
        continue;
      }
      for (const [key, value] of m.values) {
        const renderedKey = key.length > 0 ? `{${key}}` : '';
        lines.push(`${name}${renderedKey} ${value}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

/** Default registry shared by the server. Apps can inject their own. */
export const defaultMetrics = new MetricsRegistry();
