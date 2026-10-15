/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/ci-assert-native-determinism-tests.mjs');

/** `package/target` pairs the weekly workflow runs via `cargo test -p <pkg> --test <t>...`. */
function workflowTargets() {
  const targets = new Set();
  const workflow = readFileSync(join(root, '.github/workflows/determinism.yml'), 'utf8');
  for (const [, command] of workflow.matchAll(/^\s*run:\s*(cargo test\b.*)$/gm)) {
    const pkg = /(?:-p|--package)\s+(\S+)/.exec(command)?.[1];
    for (const [, name] of command.matchAll(/--test\s+(\S+)/g)) targets.add(`${pkg}/${name}`);
  }
  return targets;
}

// A recording `cargo` stand-in: every listing reports one runnable test and the
// script's own invocations are what we observe, so no real build is needed.
test('#7671: every native determinism target the weekly workflow runs is asserted runnable', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-determinism-'));
  try {
    const log = join(dir, 'cargo.log');
    const cargo = join(dir, 'cargo');
    writeFileSync(cargo, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *--ignored*) ;; *) echo 'a_test: test' ;; esac\n`);
    chmodSync(cargo, 0o755);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const asserted = new Set();
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      // `test -p <pkg> --test <target> -- --list` (the `--ignored` listing is longer).
      const [, flag, pkg, , name, , listing, ...rest] = line.split(' ');
      if (flag === '-p' && listing === '--list' && rest.length === 0) asserted.add(`${pkg}/${name}`);
    }
    const expected = workflowTargets();
    assert.ok(expected.size > 0, 'determinism.yml runs no cargo test targets');
    assert.deepEqual([...expected].filter((target) => !asserted.has(target)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
