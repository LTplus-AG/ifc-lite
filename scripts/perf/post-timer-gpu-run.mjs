/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileHash } from './interleaved-assets.mjs';
import { runGpuChild } from './gpu-outer.mjs';
import { POST_TIMER_CHILD_INPUTS, qualifyPostTimerGpuInputs, requirePostTimerFreeze } from './post-timer-gpu-qualification.mjs';
const root = resolve(import.meta.dirname, '../..'), output = join(root, 'gpu-results'), reportPath = join(output, 'post-timer-inputs-report.json');
const inputs = [...new Set([...POST_TIMER_CHILD_INPUTS, '.github/workflows/benchmark.yml', '.github/workflows/perf-gpu-check.yml',
  'scripts/perf/post-timer-gpu-run.mjs', 'scripts/perf/gpu-outer.mjs', 'scripts/perf/interleaved-assets.mjs'])];
async function freeze() {
  const sources = {}; for (const path of inputs) sources[path] = await fileHash(join(root, path));
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
    node: { version: process.version, executable: realpathSync(process.execPath), sha256: await fileHash(process.execPath) }, sources };
}
const report = { status: 'started', scope: 'Standalone live buffer/atlas byte control; no IFC/renderer/pixels/performance/whole-machine closure', retries: 0, startedUTC: new Date().toISOString() };
let created = false, abort, interrupted;
const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { interrupted = signal; abort?.('Interrupted by ' + signal); }]);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Hosted Linux/CI only');
  mkdirSync(output, { recursive: true }); writeFileSync(reportPath, JSON.stringify(report), { flag: 'wx' }); created = true;
  report.harness = await freeze();
  const capture = await runGpuChild({ root, output, name: 'post-timer-inputs.child', wallMs: 120000,
    args: ['scripts/perf/post-timer-gpu-child.mjs', join(output, 'post-timer-inputs.child.json')], onAbort: fn => { abort = fn; } });
  report.control = capture.row; report.outerRefusal = capture.refusal; report.logPaths = capture.paths;
  if (interrupted) throw new Error('Interrupted by ' + interrupted);
  report.finalHarness = await freeze(); requirePostTimerFreeze(report.harness, report.finalHarness);
  report.audit = qualifyPostTimerGpuInputs(capture, report.harness); report.status = report.audit.status; report.finalSourceVerification = 'complete';
} catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
finally {
  if (interrupted) { report.status = 'refused'; report.reason = 'Interrupted by ' + interrupted; process.exitCode = 1; }
  report.endedUTC = new Date().toISOString();
  try { if (created) writeFileSync(reportPath, JSON.stringify(report, null, 2)); }
  finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
  console.log(JSON.stringify({ status: report.status, reason: report.reason }));
}
