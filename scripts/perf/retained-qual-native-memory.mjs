#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Native retained memory (#7955 item 6, the #7955 qualification plan, "Native memory"):
// run ONE `retained_compare` invocation (a fresh process per model set) under
// `/usr/bin/time -v`, polling only its descendant `ifclite_smlib_worker` PIDs every
// 50 ms for VmRSS/VmHWM. Reports the maximum observed individual worker HWM and the
// maximum observed concurrent worker RSS sum, the executable's own max RSS and wall
// time, and the executable's own summary.json. NOT total-system RSS; sampling can
// miss a short-lived worker (the row says so). The executable's own getrusage figures
// stay in its summary (process lifetime high water, reaped children only).
//
// The retained claim is checked on the executable's summary.json: complete, zero
// violations, a retained timing block and published products (optionally pinned with
// --expect FILE {"candidates":N,"published":M}); anything else FAILS.
//
//   node scripts/perf/retained-qual-native-memory.mjs --out DIR --label advanced_model [--side base|branch] \
//     --summary /abs/out/summary.json [--worker-name ifclite_smlib_worker] \
//     [--checkout /abs/checkout [--engine /abs/staged-engine]] \
//     -- /abs/retained_compare --worker W --out OUT --manifest M
//
// --checkout records the commit; --engine (with --checkout) additionally records the
// staged engine manifest hash of the same build, so native and browser/CLI rows share one identity.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isMainEntry } from '../lib/is-main-entry.mjs';
import { engineIdentity, exclusivity, gitIdentity, hostIdentity, parseArgs, SCHEMA, sha256File, unreleasedQuietWindows, writeResult } from './retained-qual-lib.mjs';
import { startSampler } from './retained-qual-proc.mjs';
import { assertNativeSummary } from './retained-qual-assert.mjs';

export async function nativeSample({ command, workerName, summaryPath, expectation, intervalMs = 50 }) {
  if (existsSync(summaryPath)) throw new Error('summary already exists; use a fresh unique per-run path');
  const outAt = command.indexOf('--out');
  if (outAt < 0 || command.lastIndexOf('--out') !== outAt || !command[outAt + 1] || resolve(summaryPath) !== resolve(command[outAt + 1], 'summary.json')) {
    return { ok: false, error: 'summary must match the measured child --out DIR/summary.json' };
  }
  // retained_compare creates --out itself and writes summary.json there. Never
  // trust the caller's shared path: give this child a private, unpredictable path.
  mkdirSync(dirname(summaryPath), { recursive: true });
  const runDir = mkdtempSync(join(dirname(summaryPath), '.retained-run-'));
  const childOut = join(runDir, 'child');
  const measuredCommand = [...command];
  measuredCommand[outAt + 1] = childOut;
  summaryPath = join(childOut, 'summary.json');
  const timeFile = join(tmpdir(), `retained-qual-native-${process.pid}-${Date.now()}.time`);
  const started = process.hrtime.bigint();
  const child = spawn('/usr/bin/time', ['-v', '-o', timeFile, ...measuredCommand], { stdio: ['ignore', 'inherit', 'inherit'] });
  const sampler = startSampler(child.pid, { intervalMs, include: info => info.exe === workerName });
  const { code, signal } = await new Promise(done => child.on('close', (code, signal) => done({ code, signal })));
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const workers = sampler.stop();
  const time = existsSync(timeFile) ? readFileSync(timeFile, 'utf8') : '';
  rmSync(timeFile, { force: true });
  const number = key => { const m = time.match(new RegExp(`${key}[^:]*: ([\\d.]+)`)); return m ? Number(m[1]) : null; };
  const row = { ok: false, exitCode: signal ? -1 : code, signal, wallMs, executableMaxRssKiB: number('Maximum resident set size'),
    timeUserSeconds: number('User time'), timeSystemSeconds: number('System time'), workerName,
    workerProcessesObserved: workers.processes, workerPeakHwmKiB: Object.fromEntries(Object.entries(workers.byPid).map(([pid, p]) => [pid, p.hwmKiB])),
    maxIndividualWorkerHwmKiB: workers.maxIndividualHwmKiB, maxObservedConcurrentWorkerRssKiB: workers.maxObservedConcurrentRssKiB,
    samples: workers.samples, sampleIntervalMs: intervalMs, memoryCaveat: workers.caveat };
  try {
    const summary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, 'utf8')) : null;
    assertNativeSummary({ exitCode: row.exitCode, summary, expectation });
    if (workers.processes === 0) throw new Error('native: no SMLib worker process was observed; the retained worker was not demonstrably used (sampling can miss short runs)');
    Object.assign(row, { ok: true, summarySha256: await sha256File(summaryPath), summaryBytes: statSync(summaryPath).size,
      candidates: summary.candidates, published: summary.published, byCode: summary.byCode, modelsRequested: summary.modelsRequested,
      retainedMs: summary.retained.milliseconds ?? null, productMs: summary.retained.productMilliseconds ?? null,
      startupAndQualificationMs: summary.retained.startupAndQualificationMilliseconds ?? null, exactMs: summary.exact?.milliseconds ?? null,
      harnessRestarts: summary.models?.[0]?.retained?.restarts ?? null,
      // getrusage process-lifetime high water; children = reaped workers only, so null/zero is not "no worker use".
      harnessProcessMaxRssKiB: summary.models?.[0]?.retained?.processMaxRssKiB ?? null,
      harnessChildrenMaxRssKiB: summary.models?.[0]?.retained?.childrenMaxRssKiB ?? null });
  } catch (error) { row.error = error instanceof Error ? error.message : String(error); }
  // Keep successful child artifacts for inspection; failed runs remain evidence too.
  row.childOutput = childOut;
  row.measuredCommand = measuredCommand;
  return row;
}

export async function main(argv) {
  const { options, rest } = parseArgs(argv, { values: ['out', 'label', 'side', 'summary', 'worker-name', 'expect', 'checkout', 'engine', 'exclusive-receipt'], flags: ['require-quiet'] });
  if (!options.out || !options.summary || !rest.length) throw new Error('--out DIR, --summary FILE and a command after `--` are required');
  if (!existsSync('/usr/bin/time')) throw new Error('/usr/bin/time -v is required');
  if (options['require-quiet'] && unreleasedQuietWindows().length) throw new Error('Unreleased quiet window blocks Pop work');
  if (options.side && !['base', 'branch'].includes(options.side)) throw new Error('--side must be base or branch');
  const admission = exclusivity(options);
  const started = Date.now(), out = resolve(options.out);
  const expectation = options.expect ? JSON.parse(readFileSync(options.expect, 'utf8')) : undefined;
  const git = options.checkout ? gitIdentity(options.checkout) : null;
  const engine = options.checkout && options.engine ? await engineIdentity(options.checkout, options.engine) : null;
  // The executable and worker are what is measured: hash them, not just the source commit.
  const hashes = {};
  const workerAt = rest.indexOf('--worker');
  for (const [name, path] of [['executable', rest[0]], ['worker', workerAt >= 0 ? rest[workerAt + 1] : undefined]]) if (path && existsSync(path)) hashes[name] = await sha256File(path);
  mkdirSync(out, { recursive: true });
  const row = await nativeSample({ command: rest, workerName: options['worker-name'] ?? 'ifclite_smlib_worker', summaryPath: resolve(options.summary), expectation });
  Object.assign(row, { side: options.side ?? 'branch', path: options.label ?? 'native', command: rest });
  const result = { schema: SCHEMA, kind: 'native-retained-memory', reportOnly: true, exclusivity: admission, startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(), host: hostIdentity(), source: git, commit: git?.commit ?? null, engineManifestSha256: engine?.manifestSha256 ?? null,
    engineNote: 'native executable: the SDK build is identified by the worker/executable SHA-256; the manifest hash is that of --engine when given', binaries: hashes,
    samples: row.ok ? 1 : 0, rows: 1, failures: row.ok ? [] : [{ path: row.path, error: row.error }] };
  writeResult(out, result, [row]);
  console.log(row.ok ? `retained-qual-native-memory: ok; max worker HWM ${row.maxIndividualWorkerHwmKiB} KiB, wall ${row.wallMs.toFixed(0)} ms`
    : `retained-qual-native-memory: FAILED ${row.error}`);
  return row.ok ? 0 : 1;
}

if (isMainEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
