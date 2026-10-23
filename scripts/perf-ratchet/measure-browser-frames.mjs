#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Measurer for the `browser-frames` ratchet family (#6975, M4 #6959). It does
 * not run a browser: it converts the deterministic frame rig's artifact
 * (`test-results/browser-frames.json`, written by
 * tests/benchmark/frames/frame-rig.spec.ts in .github/workflows/browser-frames.yml)
 * into the measured JSON that `perf-ratchet.mjs check|lower` consumes.
 *
 *   node scripts/perf-ratchet/measure-browser-frames.mjs --frames <browser-frames.json>
 *        [--out <file>] [--commit <sha>]
 *
 * ADMISSION FIRST. The artifact passes `requireFrameEvidence` (the same
 * admission as scripts/perf/check-frame-results.mjs) before any value is read.
 * A partial, page-error or GPU-contaminated artifact is REFUSED (exit 2, no
 * output written), never evaluated: a recovered device re-uploads the whole
 * scene, so its numbers measure a different load.
 *
 * WHAT IS GATED. Only the rows in RATCHETED_FRAME_METRICS, the ones the
 * same-build repeatability evidence supports
 * (scripts/perf/evidence/gpu-frame-timing-6975/frame-ratchet/repeatability.json,
 * recomputed by scripts/perf/frame-ratchet-evidence.test.mjs). Every other row
 * goes to `informational`: shown in the report, never compared. Main-thread
 * times and load frame counts move by tens of percent between runs of one
 * build on hosted SwiftShader, and orbit/hover render counts follow the
 * viewer's adaptive throttle there, so none of them can carry a ceiling.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { isMainEntry } from '../lib/is-main-entry.mjs';

const { requireFrameEvidence } = await tsImport('../../tests/benchmark/frames/frame-evidence.ts', import.meta.url);

export const FAMILY = 'browser-frames';

/** `fixture/scenario/metric` keys with a ceiling; the evidence verdict's `ratchet` set. */
export const RATCHETED_FRAME_METRICS = [
  'Snowdon/streaming-load/gpu_write_kib',
];

/** Ratchet id for a rig row: lowercase, `_` -> `-` (ids admit `[a-z0-9._/-]`). */
export function frameMetricId(fixture, scenario, metric) {
  return `${fixture}/${scenario}/${metric}`.toLowerCase().replaceAll('_', '-');
}

function unitOf(metric) {
  if (metric.endsWith('_kib')) return 'KiB';
  if (metric.includes('_ms')) return 'ms';
  return 'count';
}

/**
 * Admit one rig artifact, then split its rows into gated metrics and
 * informational values. Throws (refusal) when admission fails.
 *
 * @param {{ evidence: unknown, commit: string, measuredAt?: string }} opts
 */
export function buildMeasured({ evidence, commit, measuredAt = new Date().toISOString() }) {
  requireFrameEvidence(evidence);
  const gated = new Set(RATCHETED_FRAME_METRICS);
  const metrics = [];
  const informational = [];
  for (const row of evidence.rows) {
    const key = `${row.fixture}/${row.scenario}/${row.metric}`;
    const entry = { id: frameMetricId(row.fixture, row.scenario, row.metric), value: row.value, unit: unitOf(row.metric) };
    if (gated.delete(key)) metrics.push({ ...entry, detail: `${key} from an admitted ${evidence.browser} artifact` });
    else informational.push(entry);
  }
  // Admission already demands every expected row; this only guards the list
  // above against naming a row the rig does not emit.
  if (gated.size) throw new Error(`ratcheted frame metric(s) absent from the artifact: ${[...gated].join(', ')}`);
  return { family: FAMILY, commit, measuredAt, metrics, informational };
}

export function parseArgs(argv) {
  const opts = { frames: null, out: null, commit: process.env.GITHUB_SHA || null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (flag === '--frames') opts.frames = resolve(v);
    else if (flag === '--out') opts.out = resolve(v);
    else if (flag === '--commit') opts.commit = v;
    else throw new Error(`unknown option ${flag}`);
  }
  if (!opts.frames) throw new Error('--frames <browser-frames.json> is required');
  if (!opts.commit) throw new Error('--commit <sha> is required outside GitHub Actions (the sha the rig measured)');
  return opts;
}

if (isMainEntry(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const evidence = JSON.parse(readFileSync(opts.frames, 'utf8'));
    const json = `${JSON.stringify(buildMeasured({ evidence, commit: opts.commit }), null, 2)}\n`;
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, json);
    }
    process.stdout.write(json);
  } catch (err) {
    console.error(`measure-browser-frames: refused: ${err.message}`);
    process.exitCode = 2;
  }
}
