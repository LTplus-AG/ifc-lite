/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Drives test.yml's real `rust-semver` registry step with `node` stubbed, and
 * checks what it writes to `needs_cargo` and how it exits. `needs_cargo=false`
 * skips the toolchain and the full gate, so it must need both exit 0 and the
 * script's own final-verdict line.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { FINAL_VERDICT_MARKER, NEEDS_TOOL_EXIT } from './check-rust-semver-registry.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/**
 * The real `rust-semver` registry step from test.yml, run with `node` stubbed,
 * so what decides `needs_cargo` is the shipped shell, not a copy of it.
 */
function runRegistryStep({ status, output }) {
  const wf = parse(readFileSync(join(SCRIPTS, '..', '.github', 'workflows', 'test.yml'), 'utf8'));
  const step = wf.jobs['rust-semver'].steps.find((s) => s.id === 'registry');
  assert.ok(step, 'test.yml rust-semver has no step with id `registry`');
  const dir = mkdtempSync(join(tmpdir(), 'semver-registry-step-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(dir, 'out.txt'), output);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ncat '${join(dir, 'out.txt')}'\nexit ${status}\n`);
    chmodSync(join(bin, 'node'), 0o755);
    const ghOutput = join(dir, 'github-output');
    writeFileSync(ghOutput, '');
    const res = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: ghOutput },
    });
    const outputs = Object.fromEntries(readFileSync(ghOutput, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
    return { exit: res.status, needsCargo: outputs.needs_cargo ?? null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FINAL = `   crate-0 6.0.1 — already published\n✅ nothing to gate\n${FINAL_VERDICT_MARKER}\n`;

for (const [name, run, expected] of [
  ['exit 0 with the final-verdict line skips cargo', { status: 0, output: FINAL }, { exit: 0, needsCargo: 'false' }],
  ['exit 0 WITHOUT the final-verdict line runs the full gate', { status: 0, output: '' }, { exit: 0, needsCargo: 'true' }],
  ['exit 0 with the marker only inside another line runs the full gate', { status: 0, output: `x ${FINAL_VERDICT_MARKER}\n` }, { exit: 0, needsCargo: 'true' }],
  ['exit 3 runs the full gate', { status: NEEDS_TOOL_EXIT, output: 'run the full gate\n' }, { exit: 0, needsCargo: 'true' }],
  ['exit 1 fails the job', { status: 1, output: FINAL }, { exit: 1, needsCargo: null }],
  ['exit 2 fails the job', { status: 2, output: '' }, { exit: 2, needsCargo: null }],
  ['any other exit fails the job', { status: 137, output: '' }, { exit: 137, needsCargo: null }],
]) {
  test(`registry step: ${name}`, () => {
    assert.deepEqual(runRegistryStep(run), expected);
  });
}
