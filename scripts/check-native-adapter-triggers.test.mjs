/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit, crateClosure, eventPaths, pathDeps, workspaceDeps } from './check-native-adapter-triggers.mjs';

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

test('removing push.paths altogether is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace(/  push:\n    branches: \[main\]\n    paths:\n(?: {6}.*\n)+/, '  push:\n    branches: [main]\n'));
  assert.ok(audit(root).some((f) => f.includes('on.push.paths is missing')));
});

test('a non-crate Rust input (Cargo.lock) dropped from both lists is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - 'Cargo.lock'\n", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('Cargo.lock') && f.includes('on.pull_request.paths')));
  assert.ok(failures.some((f) => f.includes('Cargo.lock') && f.includes('on.push.paths')));
});

test('a narrowed glob that misses tests/ is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("'rust/core/**'", "'rust/core/src/**'"));
  assert.ok(audit(root).some((f) => f.includes('crate rust/core')));
});

test('a missing path-dependency manifest is a named failure, not a smaller closure', (context) => {
  const root = copyTree(context);
  rmSync(join(root, 'rust/testkit/Cargo.toml'));
  assert.ok(audit(root).some((f) => f.includes('rust/testkit/Cargo.toml does not exist')));
  assert.throws(() => crateClosure(root), /rust\/testkit\/Cargo\.toml does not exist/);
});

test('reverting a single corpus step alone is reported', (context) => {
  const root = copyTree(context);
  let hit = 0;
  mutate(root, (t) => t.replace(/if: inputs\.corpus == true \|\| github\.event_name == 'schedule'/g, (m) => (hit++ === 1 ? 'if: inputs.corpus == true' : m)));
  assert.ok(audit(root).some((f) => f.includes('gated on inputs.corpus alone')));
});

test('a corpus step that is not continue-on-error is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('        id: native-corpus\n        if: inputs.corpus == true || github.event_name == \'schedule\'\n        continue-on-error: true\n', '        id: native-corpus\n        if: inputs.corpus == true || github.event_name == \'schedule\'\n'));
  assert.ok(audit(root).some((f) => f.includes('native-corpus must be continue-on-error')));
});

test('unthrottled main pushes or a cancelling main run are reported', (context) => {
  const noGroup = copyTree(context);
  mutate(noGroup, (t) => t.replace(/concurrency:\n(?:  .*\n)+/, ''));
  assert.ok(audit(noGroup).some((f) => f.includes('concurrency')));
  const cancelsMain = copyTree(context);
  mutate(cancelsMain, (t) => t.replace("cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'));
  assert.ok(audit(cancelsMain).some((f) => f.includes('concurrency')));
});

test('a cancelled run opening an issue, or a missing closer, is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace("needs.native-adapter.result == 'failure'", "needs.native-adapter.result != 'success'").replace('  close-red-on-main:', '  nothing:'));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes("'failure' only")));
  assert.ok(failures.some((f) => f.includes('close-red-on-main')));
});

test('pathDeps reads normal, dev, build, target and workspace-inherited path deps', () => {
  const ws = workspaceDeps('[workspace.dependencies]\nfoo = { version = "1", path = "rust/foo" }\nbar = { path = "rust/bar" }\n');
  assert.deepEqual([...ws], [['foo', 'rust/foo'], ['bar', 'rust/bar']]);
  const manifest = [
    '[dependencies]', 'foo.workspace = true', 'serde = "1"', 'local = { path = "../local" }',
    '[dev-dependencies]', 'bar = { workspace = true, features = ["x"] }',
    '[build-dependencies]', 'b = { path = "../b" } # comment',
    '[target.\'cfg(unix)\'.dependencies]', 'u = { path = "../u" }',
    '[features]', 'nope = { path = "../nope" }',
  ].join('\n');
  assert.deepEqual([...pathDeps(manifest, 'rust/me', ws)].sort(), ['rust/b', 'rust/bar', 'rust/foo', 'rust/local', 'rust/u']);
});

test('pathDeps refuses shapes it cannot read instead of shrinking the closure', () => {
  assert.throws(() => pathDeps('[dependencies.foo]\npath = "../foo"\n', 'rust/me', new Map()), /sub-table/);
  assert.throws(() => pathDeps('[dev-dependencies.foo]\npath = "../foo"\n', 'rust/me', new Map()), /sub-table/);
  assert.throws(() => pathDeps('[dependencies]\nfoo = {\n  path = "../foo",\n}\n', 'rust/me', new Map()), /multi-line/);
});

test('an unbounded native corpus step is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace(/        # A step budget[^\n]*\n        timeout-minutes: \d+\n/, ''));
  assert.ok(audit(root).some((f) => f.includes('native-corpus needs its own timeout-minutes')));
});
