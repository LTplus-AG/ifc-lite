/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A CI gate reached through a symlinked path (a symlinked checkout, or macOS
 * where the temp dir `/var/...` is a symlink to `/private/var/...`) must still
 * RUN. A hand-rolled `argv[1] === import.meta.url` entry-point guard is false
 * there, so the script fell through and exited 0 having printed and checked
 * nothing: a gate that passes by not running. Each gate below prints a verdict
 * line when it runs, so an empty output is the failure.
 *
 * Run: `node --test scripts/main-entry-symlink.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const GATES = [
  ['check-step-escaper-copies.mjs', /check:step-escapers/],
  ['check-csv-escaper-copies.mjs', /check:csv-escapers/],
  ['check-workflow-report-paths.mjs', /Workflow report-path audit/],
  ['check-ci-aggregate-coverage.mjs', /aggregate `test`/],
];

for (const [gate, verdict] of GATES) {
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
    const r = spawnSync(process.execPath, [join(link, 'scripts', gate)], { cwd: link, encoding: 'utf8' });
    assert.match(`${r.stdout}${r.stderr}`, verdict, `gate printed nothing: it never ran (exit ${r.status})`);
  });
}
