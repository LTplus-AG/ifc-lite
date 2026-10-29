/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Bounded read-only InfluxDB 2 query contract for #8090. */
export interface InfluxSelection {
  url: string;
  org: string;
  bucket: string;
  measurement: string;
  field: string;
  guidTag: string;
  tags?: Record<string, string>;
  minutes?: number;
  maxSamples?: number;
  unit: string;
}

// Flux interpolates ${...} inside strings. Reject that syntax rather than
// accepting an expression disguised as a bucket, field, or tag value.
function literal(value: string): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f]|\$\{|\{\{secret:/.test(value)) {
    throw new Error('Influx selection contains an empty, control, interpolation, or secret-reference value');
  }
  return JSON.stringify(value);
}

export function queryRequest(selection: InfluxSelection) {
  let url: URL;
  try { url = new URL(selection.url); }
  catch { throw new Error('Invalid InfluxDB base URL'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS (or http://localhost) InfluxDB base URL without credentials, query, or fragment');
  }
  literal(selection.org);
  // unit is a display label, never interpolated into the Flux query.
  const minutes = selection.minutes ?? 60;
  const maxSamples = selection.maxSamples ?? 1000;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('minutes must be 1..1440');
  if (!Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 10000) throw new Error('maxSamples must be 1..10000');
  const tags = Object.entries(selection.tags ?? {});
  if (tags.length > 16) throw new Error('At most 16 tag predicates are supported');
  const guidTag = literal(selection.guidTag);
  if (['result', 'table', 'error', 'reference'].includes(selection.guidTag) || selection.guidTag.startsWith('_')) {
    throw new Error('guidTag must be a tag, not an InfluxDB result column');
  }
  const query = [
    `from(bucket: ${literal(selection.bucket)})`,
    `  |> range(start: -${minutes}m)`,
    `  |> filter(fn: (r) => r._measurement == ${literal(selection.measurement)} and r._field == ${literal(selection.field)})`,
    `  |> filter(fn: (r) => exists r[${guidTag}])`,
    ...tags.map(([key, value]) => `  |> filter(fn: (r) => r[${literal(key)}] == ${literal(value)})`),
    // One table makes ordinary table.readCsv usable: no annotated CSV parser
    // or repeated table headers. Keep every tag column for series identity.
    '  |> group(columns: [])',
    '  |> sort(columns: ["_time"], desc: true)',
    `  |> limit(n: ${maxSamples + 1})`,
  ].join('\n');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v2/query`;
  url.searchParams.set('org', selection.org);
  return {
    url: url.href,
    hostname: url.hostname,
    maxSamples,
    body: JSON.stringify({ query, dialect: { header: true, annotations: [], dateTimeFormat: 'RFC3339Nano' } }),
  };
}
