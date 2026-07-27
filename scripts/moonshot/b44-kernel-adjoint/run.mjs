/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B4.4 runner: drives the Rust kernel-adjoint battery, captures its report and
 * machine-readable JSON, and (unless --no-wasm) runs the end-to-end forward
 * cross-check against the real wasm pipeline.
 *
 *   node scripts/moonshot/b44-kernel-adjoint/run.mjs [--no-wasm] [--release]
 *
 * Writes battery-report.txt, battery.json and kernel-cross-check.json next to
 * this file. Exits non-zero if the battery's own assertions fail.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const RELEASE = args.includes('--release');

function cargoTest(filter) {
  const argv = ['test', '-p', 'ifc-lite-geometry', '--lib'];
  if (RELEASE) argv.push('--release');
  argv.push(filter, '--', '--nocapture');
  const r = spawnSync('cargo', argv, {
    cwd: path.join(REPO_ROOT, 'rust'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, status: r.status };
}

function between(text, begin, end) {
  if (!text.includes(begin)) return null;
  return text.split(begin)[1].split(end)[0].trim();
}

console.log('[1/3] battery (cargo test b44_kernel_adjoint)');
const battery = cargoTest('b44_kernel_adjoint');
const reportPath = path.join(__dirname, 'battery-report.txt');
writeFileSync(reportPath, battery.out);
const json = between(battery.out, 'B44_JSON_BEGIN', 'B44_JSON_END');
if (json) {
  writeFileSync(path.join(__dirname, 'battery.json'), `${JSON.stringify(JSON.parse(json), null, 2)}\n`);
}
const summary = battery.out
  .split('\n')
  .filter((l) => /^(===|POINTS PASSED|  active|  invariant|  diff-spike|forward x-check)/.test(l));
console.log(summary.join('\n'));
console.log(`wrote ${reportPath}`);

console.log('\n[2/3] byte-identity guard (cargo test byte_identity)');
const bi = cargoTest('byte_identity');
console.log(bi.out.split('\n').filter((l) => l.startsWith('test ') || l.startsWith('test result')).join('\n'));

if (!args.includes('--no-wasm')) {
  console.log('\n[3/3] end-to-end wasm cross-check');
  const pts = cargoTest('b44_emit_cross_check');
  const body = between(pts.out, 'B44_XCHECK_BEGIN', 'B44_XCHECK_END');
  if (!body) {
    console.error('could not extract cross-check points');
    process.exitCode = 1;
  } else {
    const tmp = path.join(__dirname, 'cross-check-points.json');
    writeFileSync(tmp, `${body}\n`);
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, 'kernel-cross-check.mjs'), '--points', tmp],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) process.exitCode = r.status ?? 1;
  }
} else {
  console.log('\n[3/3] skipped (--no-wasm)');
}

if (battery.status !== 0 || bi.status !== 0) {
  console.error('\nRUST ASSERTIONS FAILED - see battery-report.txt');
  process.exitCode = 1;
}
