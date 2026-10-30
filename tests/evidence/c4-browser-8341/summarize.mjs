#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Summarises a browser-cohort.mts run against the #8341 targets: median observed
// readiness <= +1% and median peak memory <= base, with the base side's own
// round-to-round spread (the browser-ab-report.mjs noise floor) alongside, plus
// payload-root and diagnostic-digest identity. Timing verdicts stay with
// browser-ab-report.mjs; this adds memory and identity only.
//
// Usage: node summarize.mjs runs.jsonl [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';

const [path, ...rest] = process.argv.slice(2);
const jsonFlag = rest.indexOf('--json');
const jsonOut = jsonFlag === -1 ? null : rest[jsonFlag + 1];
const rows = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Same definition as browser-ab-report.mjs / ab-report.mjs: (max - min) / median of the base side.
const spreadPct = (xs) => (xs.length ? ((Math.max(...xs) - Math.min(...xs)) / median(xs)) * 100 : null);
const pct = (b, h) => ((h - b) / b) * 100;

const METRICS = [
  ['metadataRenderReadyMs', 'observed readiness ms', (r) => r.metadataRenderReadyMs],
  ['streamCompleteMs', 'stream-complete ms', (r) => r.streamCompleteMs],
  ['rendererPeakRssKiB', 'renderer peak RSS KiB', (r) => r.memory?.rendererPeakRssKiB],
  ['gpuPeakRssKiB', 'GPU-process peak RSS KiB', (r) => r.memory?.gpuPeakRssKiB],
  ['browserTreePeakRssSumKiB', 'browser-tree peak RSS sum KiB', (r) => r.memory?.browserTreePeakRssSumKiB],
];

const report = { fixtures: [], failures: rows.filter((r) => !r.ok).length };
for (const fixture of [...new Set(rows.map((r) => r.fixture))]) {
  const side = (arm) => rows.filter((r) => r.fixture === fixture && r.arm === arm && r.ok);
  const base = side('base');
  const head = side('branch');
  const rounds = (xs) => new Set(xs.map((r) => r.round)).size;
  const fx = { fixture, pairs: Math.min(rounds(base), rounds(head)), metrics: {} };
  for (const [key, label, get] of METRICS) {
    const b = base.map(get).filter(Number.isFinite);
    const h = head.map(get).filter(Number.isFinite);
    if (!b.length || !h.length) { fx.metrics[key] = { label, missing: true }; continue; }
    fx.metrics[key] = {
      label, baseMedian: median(b), headMedian: median(h), deltaPct: pct(median(b), median(h)),
      baseSpreadPct: spreadPct(b), headSpreadPct: spreadPct(h), baseMax: Math.max(...b), headMax: Math.max(...h),
    };
  }
  const roots = (xs) => [...new Set(xs.map((r) => r.payload?.root ?? `missing:${r.payload?.error ?? 'none'}`))];
  const digests = (xs) => [...new Set(xs.map((r) => r.diagnosticDigest ?? 'missing'))];
  fx.payload = { base: roots(base), head: roots(head), counts: base[0]?.payload && head[0]?.payload ? { base: base[0].payload, head: head[0].payload } : null };
  fx.payloadIdentical = fx.payload.base.length === 1 && fx.payload.head.length === 1 && fx.payload.base[0] === fx.payload.head[0] && !fx.payload.base[0].startsWith('missing');
  fx.diagnostics = { base: digests(base), head: digests(head) };
  fx.diagnosticsIdentical = fx.diagnostics.base.length === 1 && fx.diagnostics.head.length === 1 && fx.diagnostics.base[0] === fx.diagnostics.head[0];
  const t = fx.metrics.metadataRenderReadyMs;
  const m = fx.metrics.rendererPeakRssKiB;
  fx.targets = {
    medianTimingWithinOnePct: t && !t.missing ? t.deltaPct <= 1 : null,
    timingDeltaBeyondBaseSpread: t && !t.missing ? Math.abs(t.deltaPct) > t.baseSpreadPct : null,
    rendererPeakAtOrBelowBase: m && !m.missing ? m.headMedian <= m.baseMedian : null,
  };
  report.fixtures.push(fx);
}

for (const fx of report.fixtures) {
  console.log(`\n${fx.fixture}  (${fx.pairs} complete pairs)`);
  for (const v of Object.values(fx.metrics)) {
    if (v.missing) { console.log(`  ${v.label.padEnd(32)} missing`); continue; }
    console.log(`  ${v.label.padEnd(32)} base ${v.baseMedian.toFixed(0).padStart(9)}  head ${v.headMedian.toFixed(0).padStart(9)}  ${(v.deltaPct >= 0 ? '+' : '') + v.deltaPct.toFixed(2)}%  base spread ±${v.baseSpreadPct.toFixed(1)}%  head spread ±${v.headSpreadPct.toFixed(1)}%`);
  }
  console.log(`  payload identical: ${fx.payloadIdentical} (${fx.payload.base.join(',').slice(0, 16)}… / ${fx.payload.head.join(',').slice(0, 16)}…)`);
  console.log(`  diagnostic lines identical: ${fx.diagnosticsIdentical}`);
  console.log(`  targets: ${JSON.stringify(fx.targets)}`);
}
console.log(`\nfailed samples: ${report.failures}`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
