/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #6537 real FD syscall/process/log startup control, no IFC or timing claim.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute } from './native-hosted-process.mjs';
import { fileHash } from './interleaved-assets.mjs';
import { available, quiet } from './sdk-resources.mjs';
import { limits } from './native-hosted-plan.mjs';

const root = resolve(import.meta.dirname, '../..'), output = join(root, 'native-results/fd-startup-control');
mkdirSync(output, { recursive: true });
const helper = fileURLToPath(new URL('./native-prebuilt-control.py', import.meta.url));
const report = { status: 'pending', scope: 'dependency-free real ELF kernel FD selection and owned normal250ms execution; no IFC/timing' };
let prepared;
try {
  if (available() < limits.initialBytes) throw new Error('FD startup initial reserve refused');
  report.before = await quiet();
  const found = spawnSync('which', ['python3'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(found.status, 0, found.stderr); const python = realpathSync(found.stdout.trim());
  report.preparation = await execute([python, '-I', '-S', '-B', helper, 'prepare'], root,
    join(output, 'prepare'), { wallMs: 60000 });
  assert.equal(report.preparation.status, 'complete', report.preparation.reason);
  prepared = JSON.parse(readFileSync(report.preparation.paths.stdout, 'utf8'));
  assert.equal(readFileSync(report.preparation.paths.stderr, 'utf8'), '');
  report.prepared = prepared;
  report.files = {};
  for (const path of [python, helper, join(root, 'scripts/perf/native-prebuilt-launcher.py'),
    join(root, 'scripts/perf/native-prebuilt-policy.json'), prepared.compiler, prepared.binary,
    join(prepared.directory, 'receipt.json')]) report.files[path] = await fileHash(path);
  report.sample = await execute([python, '-I', '-S', '-B', helper, 'exec', prepared.directory], prepared.directory,
    join(output, 'sample'), { sample: true, prebuilt: true, wallMs: 60000 });
  assert.equal(report.sample.status, 'complete', report.sample.reason);
  assert.deepEqual(report.sample.observationPolicy, { scope: 'normal-native-execution', intervalMs: 250 });
  assert.equal(report.sample.cargoExceptions.length, 0);
  assert.equal(report.sample.versionProbeExceptions.length, 0);
  assert.equal(readFileSync(report.sample.paths.stderr, 'utf8'), '');
  report.actualELF = JSON.parse(readFileSync(report.sample.paths.stdout, 'utf8'));
  const witnessPath = join(prepared.directory, 'native-results/control-intent.json');
  report.intent = JSON.parse(readFileSync(witnessPath, 'utf8'));
  report.intentSha256 = await fileHash(witnessPath);
  writeFileSync(join(output, 'actual-intent.json'), readFileSync(witnessPath), { flag: 'wx' });
  const initial = report.sample.initialProcessWitness;
  assert.equal(report.actualELF.marker, 'held-original');
  assert.equal(report.actualELF.pid, initial.pid);
  assert.equal(report.intent.process.pid, initial.pid);
  assert.equal(report.intent.process.startTime, initial.startTime);
  assert.equal(report.intent.process.pgrp, initial.pgrp);
  assert.equal(report.intent.process.ppid, report.sample.parentPid);
  assert.equal(report.intent.process.cwd, prepared.directory);
  assert.equal(report.actualELF.dev, report.intent.held.dev);
  assert.equal(report.actualELF.ino, report.intent.held.ino);
  assert.deepEqual(report.actualELF.argv, report.intent.argv);
  for (const [path, sha256] of Object.entries(report.files)) assert.equal(await fileHash(path), sha256);
  report.finalFilesVerified = true; report.after = await quiet();
  report.status = 'qualified-real-FD-startup-only';
} catch (error) {
  report.status = 'refused'; report.reason = String(error); if (error.receipt) report.cpuRefusal = error.receipt;
  process.exitCode = 1;
} finally {
  if (prepared?.directory) {
    rmSync(prepared.directory, { recursive: true, force: true });
    report.ownedTempRemoved = !existsSync(prepared.directory);
  }
  writeFileSync(join(output, 'control.json'), JSON.stringify(report, null, 2));
}
