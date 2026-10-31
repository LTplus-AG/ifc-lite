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
  const files = ['Cargo.toml', WORKFLOW, 'scripts/check-native-adapter-triggers.mjs', 'scripts/lib/ci-path-coverage.mjs', 'scripts/lib/is-main-entry.mjs', ...crateClosure(REPO).map((dir) => `${dir}/Cargo.toml`)];
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

test('the real workflow covers its whole dependency closure and keeps its opt-in and nightly', () => {
  assert.deepEqual(audit(REPO), []);
});

test('the closure includes the shared crates the exact route also uses', () => {
  const closure = crateClosure(REPO);
  for (const dir of ['rust/core', 'rust/geometry', 'rust/processing', 'rust/geometry-runtime', 'rust/retained-native']) {
    assert.ok(closure.includes(dir), `${dir} missing from ${closure}`);
  }
});

test('dropping a crate from the path list is reported by name', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - 'rust/core/**'\n", ''));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('crate rust/core') && f.includes('on.pull_request.paths')), failures.join('\n'));
});

test('a push trigger or a missing nightly schedule is refused', (context) => {
  const pushed = copyTree(context);
  mutate(pushed, (t) => t.replace('on:\n', 'on:\n  push:\n    branches: [main]\n'));
  assert.ok(audit(pushed).some((f) => f.includes('must not trigger on push')));
  const noNightly = copyTree(context);
  mutate(noNightly, (t) => t.replace(/  schedule:\n    - cron: '[^']+'\n/, ''));
  assert.ok(audit(noNightly).some((f) => f.includes('on.schedule')));
});

test('an inline paths list is refused rather than read as empty', () => {
  assert.throws(() => eventPaths("on:\n  push:\n    paths:\n      - rust/core/**\n", 'push'), /unparseable/);
});

test('a non-crate Rust input (Cargo.lock) dropped from the list is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - 'Cargo.lock'\n", ''));
  assert.ok(audit(root).some((f) => f.includes('Cargo.lock') && f.includes('on.pull_request.paths')));
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

test('a lost per-PR group, a cancelling nightly or a workflow-level group are reported', (context) => {
  const noGroup = copyTree(context);
  mutate(noGroup, (t) => t.replace(/    concurrency:\n(?: {6}.*\n)+/, ''));
  assert.ok(audit(noGroup).some((f) => f.includes('concurrency must be per-PR')));
  const cancelsNightly = copyTree(context);
  mutate(cancelsNightly, (t) => t.replace(`cancel-in-progress: \${{ github.event_name == 'pull_request' }}`, 'cancel-in-progress: true'));
  assert.ok(audit(cancelsNightly).some((f) => f.includes('concurrency must be per-PR')));
  const workflowLevel = copyTree(context);
  mutate(workflowLevel, (t) => t.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n\nconcurrency:\n  group: x\n'));
  assert.ok(audit(workflowLevel).some((f) => f.includes('not the workflow')));
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
  assert.ok(audit(root).some((f) => f.includes('local action .github/actions/setup-wasm-build') && f.includes('on.pull_request.paths')));
});

test('losing the opt-in label gate or the labeled type is reported', (context) => {
  const ungated = copyTree(context);
  mutate(ungated, (t) => t.replace(/    if: >-\n(?: {6}.*\n)+/, ''));
  assert.ok(audit(ungated).some((f) => f.includes('must keep its opt-in gate')));
  const looser = copyTree(context);
  mutate(looser, (t) => t.replace("(github.event.action != 'labeled' || github.event.label.name == 'ci:native-adapter')", 'true'));
  assert.ok(audit(looser).some((f) => f.includes('must keep its opt-in gate')));
  const noLabeled = copyTree(context);
  mutate(noLabeled, (t) => t.replace('types: [opened, synchronize, reopened, labeled]', 'types: [opened, synchronize, reopened]'));
  assert.ok(audit(noLabeled).some((f) => f.includes('types must include labeled')));
});


const realWorkflow = () => readFileSync(join(REPO, WORKFLOW), 'utf8');

test('the real corpus job is its own sharded, bounded, judged job', () => {
  const text = realWorkflow();
  assert.deepEqual(corpusJobProblems(text), []);
  assert.notEqual(jobBlock(text, 'native-corpus-result'), null);
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
  mutate(root, (t) => t.replace('check-retained-corpus-summary.mjs --shards 8 ', 'check-retained-corpus-summary.mjs --shards 7 ').replace('--shards 8 --index', '--shards 4 --index'));
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


test('a script the lane runs, or one it imports, must be able to trigger it', (context) => {
  const direct = copyTree(context);
  mutate(direct, (t) => t.replaceAll("      - 'scripts/check-native-adapter-triggers.mjs'\n", ''));
  assert.ok(audit(direct).some((f) => f.includes('scripts/check-native-adapter-triggers.mjs is run by')));
  const imported = copyTree(context);
  mutate(imported, (t) => t.replaceAll("      - 'scripts/lib/ci-path-coverage.mjs'\n", ''));
  assert.ok(audit(imported).some((f) => f.includes('scripts/lib/ci-path-coverage.mjs is run by')));
});

test('a browser corpus job that does not fetch the corpus is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace(/      # The models the product table names come from the fetch, not the checkout.\n      - name: Download the corpus\n        run: pnpm fixtures\n/, ''));
  assert.ok(audit(root).some((f) => f.includes('browser-corpus must download the corpus')));
});

test('dotted keys refuse; both TOML string quotes read as a path', () => {
  assert.throws(() => pathDeps('[dependencies]\nfoo.path = "../foo"\n', 'rust/me', new Map()), /dotted key foo\.path/);
  assert.throws(() => pathDeps('[dev-dependencies]\nfoo.default-features = false\n', 'rust/me', new Map()), /dotted key/);
  assert.deepEqual([...pathDeps("[dependencies]\nfoo = { path = '../foo' }\nbar.workspace = true\n", 'rust/me', new Map())], ['rust/foo']);
  assert.throws(() => workspaceDeps('[workspace.dependencies]\nfoo.path = "rust/foo"\n'), /dotted key foo\.path/);
  assert.deepEqual([...workspaceDeps("[workspace.dependencies]\nfoo = { path = 'rust/foo' }\n")], [['foo', 'rust/foo']]);
});

test('an if: always() on an earlier step does not satisfy the judge-step check', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t
    .replace('      - name: Download the corpus\n        run: pnpm fixtures\n      - name: Select', '      - name: Download the corpus\n        if: always()\n        run: pnpm fixtures\n      - name: Select')
    .replace('      - name: Judge this shard\n        if: always()\n', '      - name: Judge this shard\n'));
  assert.ok(audit(root).some((f) => f.includes('if: always() step')));
});

test('an unreadable matrix reports the real cause once, without a size-0 remedy', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace(/        shard: \[[0-9, ]+\]\n/, `        shard: \${{ fromJSON('[0,1]') }}\n`));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('matrix shard must list 0..N-1')));
  assert.ok(!failures.some((f) => f.includes('(0)') || f.includes('exactly the matrix\'s 0')), failures.join('\n'));
});
