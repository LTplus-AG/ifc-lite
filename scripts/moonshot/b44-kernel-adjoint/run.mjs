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
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const args = process.argv.slice(2);
const RELEASE = args.includes('--release');

/**
 * Strip cargo's build chatter and any workstation identity from captured output
 * before it is committed as an artifact.
 *
 * `battery-report.txt` is checked in as the run's evidence, and cargo's own
 * progress lines carry absolute paths into the toolchain, the registry and the
 * user's home directory - i.e. a local account name, in a public repo, in a file
 * whose whole purpose is to be read by strangers. None of that is evidence: the
 * evidence is the harness's own report between the marker lines. So the progress
 * lines go, and whatever absolute paths survive in a compiler diagnostic or a
 * panic message are redacted rather than trusted to be harmless.
 *
 * `Finished ... in 8.41s` and `Running unittests ... (target/debug/deps/x-<hash>)`
 * go for a second reason: a build time and a binary hash change on every run, so
 * keeping them means the committed artifact diffs when nothing measured moved.
 */
function sanitize(text) {
  const dropped =
    /^\s+(Compiling|Checking|Downloaded|Downloading|Updating|Locking|Adding|Removing|Fresh|Blocking|Installing|Building|Finished|Running)\b/;
  return text
    .split('\n')
    .filter((l) => !dropped.test(l))
    .join('\n')
    .split(REPO_ROOT)
    .join('<repo>')
    .split(os.homedir())
    .join('~')
    .replace(/\/(Users|home)\/[^/\s"'):]+/g, '/$1/<user>');
}

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
writeFileSync(reportPath, sanitize(battery.out));
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
console.log(
  sanitize(bi.out)
    .split('\n')
    .filter((l) => l.startsWith('test ') || l.startsWith('test result'))
    .join('\n'),
);

if (!args.includes('--no-wasm')) {
  console.log('\n[3/3] end-to-end wasm cross-check');
  const pts = cargoTest('b44_emit_cross_check');
  if (pts.status !== 0) {
    // Until 2026-08-01 this branch did not exist. A compile failure was caught
    // downstream (no markers -> "could not extract cross-check points"), but a
    // run that PRINTED its points and then failed - a panic after the emission,
    // an abort, a signal - handed those points to the wasm leg and, since that
    // leg could not fail either (see kernel-cross-check.mjs), printed
    // "cross-check PASS" and exited 0. Verified by injecting a panic at the end
    // of `b44_emit_cross_check_points`: cargo exited 101 and the old flow
    // reported a pass. Points from a failing run are not a measurement.
    console.error(
      `\ncross-check point emission failed (cargo exit ${pts.status ?? 'signal'}); ` +
        'the wasm leg is skipped because its inputs are not this revision\'s.',
    );
    console.error(sanitize(pts.out));
    process.exitCode = 1;
  } else if (!between(pts.out, 'B44_XCHECK_BEGIN', 'B44_XCHECK_END')) {
    console.error('could not extract cross-check points');
    process.exitCode = 1;
  } else {
    const body = between(pts.out, 'B44_XCHECK_BEGIN', 'B44_XCHECK_END');
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
