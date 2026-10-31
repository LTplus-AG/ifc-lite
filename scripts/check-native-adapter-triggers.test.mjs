/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit, corpusJobProblems, crateClosure, eventPaths, jobBlock, pathDeps, workspaceDeps } from './check-native-adapter-triggers.mjs';

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
  mutate(root, (t) => t.replace("    branches: [main]\n", '').replace(/  schedule:\n    - cron: '[^']+'\n/, ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('branches: [main]')));
  assert.ok(failures.some((f) => f.includes('on.schedule')));
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

test('probe-file globs that leave the rest of a crate untriggered are reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - 'rust/core/**'\n", "      - 'rust/core/Cargo.toml'\n      - 'rust/core/src/lib.rs'\n      - 'rust/core/tests/probe.rs'\n"));
  assert.ok(audit(root).some((f) => f.includes('crate rust/core') && f.includes("add 'rust/core/**'")));
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

test('unthrottled main pushes, a cancelling main run or a workflow-level group are reported', (context) => {
  const noGroup = copyTree(context);
  mutate(noGroup, (t) => t.replace(/    concurrency:\n(?: {6}.*\n)+/, ''));
  assert.ok(audit(noGroup).some((f) => f.includes('concurrency must group by event and ref')));
  const runIdGroup = copyTree(context);
  mutate(runIdGroup, (t) => t.replace('group: native-adapter-${{ github.event_name }}-${{ github.ref }}', 'group: native-adapter-${{ github.run_id }}'));
  assert.ok(audit(runIdGroup).some((f) => f.includes('concurrency must group by event and ref')));
  const cancelsMain = copyTree(context);
  mutate(cancelsMain, (t) => t.replace(`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`, 'cancel-in-progress: true'));
  assert.ok(audit(cancelsMain).some((f) => f.includes('concurrency must group by event and ref')));
  const workflowLevel = copyTree(context);
  mutate(workflowLevel, (t) => t.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n\nconcurrency:\n  group: x\n'));
  assert.ok(audit(workflowLevel).some((f) => f.includes('not the workflow')));
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

test('a workspace.dependencies sub-table or multi-line table refuses instead of dropping a crate', () => {
  assert.throws(() => workspaceDeps('[workspace.dependencies.newcrate]\npath = "rust/newcrate"\n'), /not parsed/);
  assert.throws(() => workspaceDeps('[workspace.dependencies]\nnewcrate = {\n  path = "rust/newcrate",\n}\n'), /multi-line/);
});

test('a local action the job calls must be able to trigger it', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - '.github/actions/setup-wasm-build/**'\n", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('local action .github/actions/setup-wasm-build') && f.includes('on.pull_request.paths')));
  assert.ok(failures.some((f) => f.includes('local action .github/actions/setup-wasm-build') && f.includes('on.push.paths')));
});


const realWorkflow = () => readFileSync(join(REPO, WORKFLOW), 'utf8');

test('the real corpus job is its own sharded, bounded, judged job', () => {
  const text = realWorkflow();
  assert.deepEqual(corpusJobProblems(text), []);
  assert.ok(jobBlock(text, 'native-corpus-result').includes('--shards 8'));
});

test('running the corpus inside native-adapter again is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('      - name: Upload native comparison evidence', '      - run: cargo run --example retained_compare -- --manifest tests/models/manifest.json\n      - name: Upload native comparison evidence'));
  assert.ok(audit(root).some((f) => f.includes('belongs in the native-corpus job')));
});

test('a corpus job that runs on every PR, or has no literal budget, is reported', (context) => {
  const ungated = copyTree(context);
  mutate(ungated, (t) => t.replace("    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120", "    runs-on: ubuntu-24.04\n    timeout-minutes: 120"));
  assert.ok(audit(ungated).some((f) => f.includes('native-corpus must be gated')));
  const unbounded = copyTree(context);
  mutate(unbounded, (t) => t.replace('    timeout-minutes: 120\n    strategy:', '    timeout-minutes: 400\n    strategy:'));
  assert.ok(audit(unbounded).some((f) => f.includes('360-minute')));
});

test('a shard count that disagrees between matrix, selection and aggregate is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('check-retained-corpus-summary.mjs --shards 8 ', 'check-retained-corpus-summary.mjs --shards 7 ').replace('--index ${{ matrix.shard }}', '--index ${{ matrix.shard }}').replace('--shards 8 --index', '--shards 4 --index'));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('--shards must equal the matrix size')));
  assert.ok(failures.some((f) => f.includes('exactly the matrix')));
});

test('a compare step that is fatal or unbounded, or an unjudged shard, is reported', (context) => {
  const fatal = copyTree(context);
  mutate(fatal, (t) => t.replace('        id: compare\n        continue-on-error: true\n', '        id: compare\n        continue-on-error: false\n        # continue-on-error: true\n'));
  assert.ok(audit(fatal).some((f) => f.includes('comparison step needs continue-on-error')));
  const unjudged = copyTree(context);
  mutate(unjudged, (t) => t.replace('        if: always()\n        env:\n          COMPARE_OUTCOME', '        env:\n          COMPARE_OUTCOME'));
  assert.ok(audit(unjudged).some((f) => f.includes('if: always() step')));
});

test('an aggregate that does not need the matrix or ignores its result, and a reporter that ignores the corpus, are reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('    needs: [native-corpus]\n', '    needs: []\n').replace('          [[ "$SHARDS_RESULT" == success ]]\n', '').replace('needs: [native-adapter, native-corpus-result]\n    if: always() && github.event_name', 'needs: [native-adapter]\n    if: always() && github.event_name'));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('must need native-corpus')));
  assert.ok(failures.some((f) => f.includes('matrix result is not success')));
  assert.ok(failures.some((f) => f.includes('report-scheduled-failure must need native-corpus-result')));
});

test('a browser corpus that can fail the run is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('    continue-on-error: true\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v4\n        with:\n          persist-credentials: false\n      - uses: pnpm', '    runs-on: ubuntu-24.04\n    timeout-minutes: 120\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v4\n        with:\n          persist-credentials: false\n      - uses: pnpm'));
  assert.ok(audit(root).some((f) => f.includes('browser-corpus must exist and stay report-only')));
});

test('a reporter that loses its stale-rerun guard is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("is not main's head", 'differs'));
  assert.ok(audit(root).some((f) => f.includes('stale rerun')));
});
