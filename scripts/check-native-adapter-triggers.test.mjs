/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit, crateClosure, eventPaths } from './check-native-adapter-triggers.mjs';

const REPO = join(import.meta.dirname, '..');
const WORKFLOW = '.github/workflows/geometry-platform.yml';

/** A tree with the real workflow and every crate manifest the closure reads. */
function copyTree(context) {
  const root = mkdtempSync(join(tmpdir(), 'native-adapter-triggers-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['Cargo.toml', WORKFLOW, ...crateClosure(REPO).map((dir) => `${dir}/Cargo.toml`)];
  for (const f of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    cpSync(join(REPO, f), join(root, f));
  }
  return root;
}
const mutate = (root, fn) => {
  const path = join(root, WORKFLOW);
  writeFileSync(path, fn(readFileSync(path, 'utf8')));
};

test('the real workflow covers its whole dependency closure, on main and nightly', () => {
  assert.deepEqual(audit(REPO), []);
});

test('the closure includes the shared crates the exact route also uses', () => {
  const closure = crateClosure(REPO);
  for (const dir of ['rust/core', 'rust/geometry', 'rust/processing', 'rust/geometry-runtime', 'rust/retained-native']) {
    assert.ok(closure.includes(dir), `${dir} missing from ${closure}`);
  }
});

test('dropping a crate from both path lists is reported by name', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - 'rust/core/**'\n", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('crate rust/core') && f.includes('on.pull_request.paths')), failures.join('\n'));
  assert.ok(failures.some((f) => f.includes('crate rust/core') && f.includes('on.push.paths')), failures.join('\n'));
});

test('pull_request and push path lists may not drift', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace("      - 'rust/testkit/**'\n", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes("rust/testkit/**") && f.includes('not')), failures.join('\n'));
});

test('a workflow without a push, schedule or corpus-on-schedule is refused', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace("    branches: [main]\n", '').replace(/  schedule:\n    - cron: '[^']+'\n/, '').replaceAll(" || github.event_name == 'schedule'", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('branches: [main]')));
  assert.ok(failures.some((f) => f.includes('on.schedule')));
  assert.ok(failures.some((f) => f.includes('corpus')));
});

test('a workflow without the red-run reporters is refused', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('  report-red-on-main:', '  quiet-on-main:').replace('  report-scheduled-failure:', '  quiet-nightly:'));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('report-red-on-main')));
  assert.ok(failures.some((f) => f.includes('report-scheduled-failure')));
});

test('an inline paths list is refused rather than read as empty', () => {
  assert.throws(() => eventPaths("on:\n  push:\n    paths:\n      - rust/core/**\n", 'push'), /unparseable/);
});
