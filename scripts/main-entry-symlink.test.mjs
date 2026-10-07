/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A CI gate reached through a symlinked path (a symlinked checkout, or macOS
 * where the temp dir `/var/...` is a symlink to `/private/var/...`) must still
 * RUN (#7025). A hand-rolled `argv[1] === import.meta.url` entry-point guard is
 * false there, so the script fell through and exited 0 having printed and
 * checked nothing: a gate that passes by not running.
 *
 * Each gate below prints a verdict line when its `main()` runs, so the verdict
 * line is the observation in all three directions:
 *   - run directly            -> the verdict is printed;
 *   - run through a symlink   -> the verdict is printed (the defect: it was not);
 *   - imported, not run       -> the verdict is NOT printed.
 * The symlink is created by the test, so the middle case means the same thing
 * on Linux CI as on macOS. The gates are read-only checks of the tracked tree;
 * scripts with side effects (uploads, builds, benchmarks) are covered by the
 * shape gate, scripts/check-main-entry-guards.mjs, not executed here.
 *
 * Run: `node --test scripts/main-entry-symlink.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  ['check-step-escaper-copies.mjs', /check:step-escapers/],
  ['check-csv-escaper-copies.mjs', /check:csv-escapers/],
  ['check-workflow-report-paths.mjs', /Workflow report-path audit/],
  ['check-ci-aggregate-coverage.mjs', /aggregate `test`/],
  ['check-path-case-collisions.mjs', /check-path-case-collisions:/],
  ['check-perf-flags.mjs', /check-perf-flags:/],
];

const run = (args, cwd) => {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
};

for (const [gate, verdict] of GATES) {
  test(`${gate} runs when invoked directly`, { timeout: 120_000 }, () => {
    const r = run([join(REPO, 'scripts', gate)], REPO);
    assert.match(r.output, verdict, `gate printed no verdict (exit ${r.status})`);
  });

  test(`${gate} runs when invoked through a symlink to the checkout`, { timeout: 120_000 }, (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'main-entry-symlink-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const link = join(dir, 'checkout');
    try {
      symlinkSync(REPO, link, 'dir');
    } catch (err) {
      if (err && (err.code === 'EPERM' || err.code === 'EACCES')) return t.skip('cannot create a symlink here');
      throw err;
    }
    const r = run([join(link, 'scripts', gate)], link);
    assert.match(r.output, verdict, `gate printed nothing: it never ran (exit ${r.status})`);
  });

  test(`${gate} does not run when it is only imported`, { timeout: 120_000 }, () => {
    const url = pathToFileURL(join(REPO, 'scripts', gate)).href;
    const r = run(['--input-type=module', '-e', `await import(${JSON.stringify(url)}); console.log('imported');`], REPO);
    assert.match(r.output, /imported/, `the import itself failed (exit ${r.status}): ${r.output}`);
    assert.doesNotMatch(r.output, verdict, 'importing the module ran its main()');
  });
}
