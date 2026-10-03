/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Standalone hosted qualification only: no comparator, IFC or timed observer.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runGpuChild } from './gpu-outer.mjs';
import { fileHash } from './interleaved-assets.mjs';
import { qualifySymbolicUpload, requireFrozenSources } from './symbolic-upload-qualification.mjs';
const root = resolve(import.meta.dirname, '../..'), output = join(root, 'gpu-results');
mkdirSync(output, { recursive: true });
const paths = ['.github/workflows/benchmark.yml', '.github/workflows/perf-gpu-check.yml', 'package.json', 'pnpm-lock.yaml',
  ...['symbolic-upload-gpu-run.mjs', 'symbolic-upload-gpu-control.mjs', 'symbolic-upload-gpu-page.mjs',
    'symbolic-upload-recorder.mjs', 'symbolic-upload-qualification.mjs', 'gpu-outer.mjs', 'gpu-control.mjs',
    'interleaved-plan.mjs', 'interleaved-assets.mjs', 'interleaved-cleanup.mjs'].map(n => 'scripts/perf/' + n)];
async function freeze() {
  const sources = {};
  for (const path of paths) sources[path] = await fileHash(join(root, path));
  return { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim(),
    node: { version: process.version, executable: realpathSync(process.execPath), sha256: await fileHash(process.execPath) }, sources };
}
const report = { status: 'started', scope: 'Standalone actual GPU upload input control; no IFC/text completeness/atlas/pixels/timing verdict',
  retries: 0, startedUTC: new Date().toISOString() };
let activeAbort, interrupted, created = false;
const handlers = ['SIGTERM', 'SIGINT'].map(signal => [signal, () => { interrupted = signal; activeAbort?.('Interrupted by ' + signal); }]);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
  if (process.platform !== 'linux' || process.env.CI !== 'true') throw new Error('Hosted Linux qualification only');
  writeFileSync(join(output, 'symbolic-upload-report.json'), JSON.stringify(report), { flag: 'wx' }); created = true;
  report.harness = await freeze();
  const capture = await runGpuChild({ root, output, name: 'symbolic-upload.child', wallMs: 120000,
    args: ['scripts/perf/symbolic-upload-gpu-control.mjs', join(output, 'symbolic-upload.child.json')],
    onAbort: abort => { activeAbort = abort; } });
  report.control = capture.row;
  report.outerRefusal = capture.refusal; report.logPaths = capture.paths;
  if (interrupted) throw new Error('Interrupted by ' + interrupted);
  report.finalHarness = await freeze(); requireFrozenSources(report.harness, report.finalHarness);
  report.status = qualifySymbolicUpload(capture, report.harness);
  report.finalSourceVerification = 'complete';
} catch (error) { report.status = 'refused'; report.reason = String(error); process.exitCode = 1; }
finally {
  if (interrupted) { report.status = 'refused'; report.reason = 'Interrupted by ' + interrupted; process.exitCode = 1; }
  report.endedUTC = new Date().toISOString();
  try { if (created) writeFileSync(join(output, 'symbolic-upload-report.json'), JSON.stringify(report, null, 2)); }
  finally { for (const [signal, handler] of handlers) process.removeListener(signal, handler); }
  console.log(JSON.stringify({ status: report.status, reason: report.reason }));
}
