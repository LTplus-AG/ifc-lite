/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PROFILES, verdict, interpretation, requireCompletion } from './gpu-control.mjs';
import { runGpuChild } from './gpu-outer.mjs';
import { fileHash } from './interleaved-assets.mjs';

const root = resolve(import.meta.dirname, '../..'), output = join(root, 'gpu-results');
mkdirSync(output, { recursive: true });
const report = { status: 'started', profiles: [], plannedControls: 2, retries: 0, startedUTC: new Date().toISOString() };
let activeAbort, interrupted;
const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { interrupted = signal; activeAbort?.(`Interrupted by ${signal}`); }]);
for (const [signal, handler] of handlers) process.on(signal, handler);
async function control(profile) {
  const { row, backend, exit, cleanup, flushes, refusal } = await runGpuChild({ root, output,
    name: profile.name, args: ['scripts/perf/gpu-sample.mjs', profile.name, output],
    eventFile: `${profile.name}.events.jsonl`, onAbort: abort => { activeAbort = abort; } });
  const childStatus = row.status; row.status = verdict(row, backend);
  row.childStatus = childStatus;
  if (row.status === 'refused') row.reason ??= 'Pixel/frame witness or observed GPU/backend error refused';
  if (refusal || exit.code !== 0 || cleanup.status !== 'complete' || flushes.some(value => value.status !== 'complete') || row.teardown !== 'complete') {
    row.status = 'refused'; row.reason ??= refusal ?? 'Child/cleanup/log/teardown refused';
  }
  writeFileSync(join(output, `${profile.name}.json`), JSON.stringify(row, null, 2));
  return row;
}
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Hosted Linux control only');
  report.harness = { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
    scope: 'Listed harness inputs only; not a whole-machine or dependency closure', sources: {},
    node: { version: process.version, executable: realpathSync(process.execPath), sha256: await fileHash(process.execPath) } };
  for (const path of ['.github/workflows/benchmark.yml', '.github/workflows/perf-gpu-check.yml', 'package.json', 'pnpm-lock.yaml',
    ...['gpu-control.mjs', 'gpu-page.mjs', 'gpu-run.mjs', 'gpu-sample.mjs', 'gpu-outer.mjs', 'interleaved-assets.mjs', 'interleaved-cleanup.mjs'].map(name => `scripts/perf/${name}`)])
    report.harness.sources[path] = await fileHash(join(root, path));
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  for (const profile of PROFILES) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}; remaining control not run`);
    report.profiles.push(await control(profile));
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  report.interpretation = interpretation(report.profiles);
  report.status = requireCompletion(report.profiles, interrupted);
} catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
finally {
  if (interrupted) { report.status = 'refused'; report.reason = `Interrupted by ${interrupted}; completion refused`; process.exitCode = 1; }
  report.endedUTC = new Date().toISOString();
  try { writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
}
