/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The registry-only semver run must return the full gate's verdict whenever it
 * returns one, and must hand over (NEEDS_TOOL) whenever the full gate would
 * have compared an API. Each scenario runs both: the full gate with runners
 * that THROW, so a scenario where the full gate needs cargo cannot pass as
 * equal by accident.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { checkRustSemver } from './check-rust-semver.mjs';
import { FINAL_VERDICT_MARKER, NEEDS_TOOL_EXIT, registryOnlyVerdict } from './check-rust-semver-registry.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const NINE = Array.from({ length: 9 }, (_, i) => `crate-${i}`);
const at = (v) => () => v;

const SCENARIOS = [
  { name: 'every crate already published at the workspace version', crates: NINE, ws: '6.0.1', published: at('6.0.1'), needsTool: false, ok: true },
  { name: 'workspace version ahead of crates.io', crates: NINE, ws: '6.0.2', published: at('6.0.1'), needsTool: true },
  { name: 'one crate ahead, the rest already published', crates: NINE, ws: '6.0.2', published: (c) => (c === 'crate-4' ? '6.0.1' : '6.0.2'), needsTool: true },
  { name: 'workspace version behind crates.io', crates: NINE, ws: '6.0.1', published: at('7.0.0'), needsTool: false, ok: false, failure: /VERSION_NOT_ADVANCED/ },
  { name: 'no crate has a baseline', crates: NINE, ws: '6.0.2', published: at(null), needsTool: false, ok: false, failure: /NO_BASELINE/ },
  { name: 'a baseline that is not a semver triple', crates: NINE, ws: '6.0.2', published: at('6.0'), needsTool: false, ok: false, failure: /BAD_BASELINE/ },
  { name: 'an unreadable workspace version', crates: NINE, ws: null, published: at('6.0.1'), needsTool: false, ok: false, failure: /BAD_VERSION/ },
  { name: 'an empty crate list', crates: [], ws: '6.0.2', published: at('6.0.1'), needsTool: false, ok: false, failure: /NO_CRATES/ },
  { name: 'a crate list under the floor', crates: NINE.slice(0, 3), ws: '6.0.2', published: at('6.0.1'), needsTool: false, ok: false, failure: /CRATE_FLOOR/ },
  { name: 'one crate without a baseline, another ahead', crates: NINE, ws: '6.0.2', published: (c) => (c === 'crate-0' ? null : '6.0.1'), needsTool: true },
  { name: 'one crate behind, the rest already published', crates: NINE, ws: '6.0.2', published: (c) => (c === 'crate-0' ? '7.0.0' : '6.0.2'), needsTool: false, ok: false, failure: /VERSION_NOT_ADVANCED/ },
];

const refuse = () => {
  throw new Error('the full gate asked for cargo-semver-checks');
};

for (const s of SCENARIOS) {
  test(`registry-only: ${s.name}`, () => {
    const input = { crates: s.crates, workspaceVersion: s.ws, latestPublished: s.published };
    const verdict = registryOnlyVerdict(input);
    assert.equal(verdict.needsTool, s.needsTool);
    if (s.needsTool) {
      // The full gate really does reach the tool here.
      assert.throws(() => checkRustSemver({ ...input, runSemverChecks: refuse, runTagBaseline: refuse }), /asked for cargo/);
      return;
    }
    const full = checkRustSemver({ ...input, runSemverChecks: refuse, runTagBaseline: refuse });
    assert.deepEqual(verdict.result, full);
    assert.equal(verdict.result.ok, s.ok);
    if (s.failure) assert.match(verdict.result.failures.join('\n'), s.failure);
  });
}

test('registry-only CLI never needs cargo and never claims a compatibility result', () => {
  // No cargo on PATH: the full gate would exit 2 with TOOL_MISSING here.
  const res = spawnSync(process.execPath, [join(SCRIPTS, 'check-rust-semver-registry.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: join(SCRIPTS, 'no-such-directory-for-path') + delimiter },
  });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  assert.doesNotMatch(out, /TOOL_MISSING/);
  assert.doesNotMatch(out, /every Rust API change fits/);
  const marked = out.split('\n').includes(FINAL_VERDICT_MARKER);
  assert.equal(marked, res.status === 0, 'the final-verdict line appears exactly when the exit is 0');
  if (res.status === 0) return assert.match(out, /nothing to gate/);
  if (res.status === 1) return assert.match(out, /Rust crate semver gate failed/);
  if (res.status === 2) return assert.match(out, /REGISTRY_LOOKUP_FAILED/);
  if (res.status === NEEDS_TOOL_EXIT) return assert.match(out, /run the full gate/);
  assert.fail(`exit ${res.status} with output this test cannot classify:\n${out}`);
});

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
    spawnSync('mkdir', [bin]);
    writeFileSync(join(dir, 'out.txt'), output);
    writeFileSync(join(bin, 'node'), `#!/bin/sh\ncat '${join(dir, 'out.txt')}'\nexit ${status}\n`);
    chmodSync(join(bin, 'node'), 0o755);
    const ghOutput = join(dir, 'github-output');
    writeFileSync(ghOutput, '');
    const res = spawnSync('bash', ['-e', '-c', step.run], {
      encoding: 'utf8',
      env: { ...process.env, PATH: bin + delimiter + process.env.PATH, RUNNER_TEMP: dir, GITHUB_OUTPUT: ghOutput },
    });
    return { exit: res.status, needsCargo: readFileSync(ghOutput, 'utf8').match(/^needs_cargo=(.*)$/m)?.[1] ?? null };
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
