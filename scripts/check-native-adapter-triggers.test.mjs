/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { audit, corpusJobProblems, crateClosure, eventPaths, jobBlock, pathDeps, workspaceDeps } from './check-native-adapter-triggers.mjs';
import { parse as parseYaml } from 'yaml';
import { permissionBlocks, scan } from './lib/workflow-permissions.mjs';

const REPO = join(import.meta.dirname, '..');
const WORKFLOW = '.github/workflows/geometry-platform.yml';
const TEST_WORKFLOW = '.github/workflows/test.yml';

const BISECT = '.github/workflows/native-adapter-bisect.yml';

/** A tree with the real workflow and every crate manifest the closure reads. */
function copyTree(context) {
  const root = mkdtempSync(join(tmpdir(), 'native-adapter-triggers-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['Cargo.toml', WORKFLOW, TEST_WORKFLOW, 'scripts/check-native-adapter-triggers.mjs', 'scripts/lib/ci-path-coverage.mjs', 'scripts/lib/workflow-job-condition.mjs', 'scripts/lib/is-main-entry.mjs', 'scripts/lib/workflow-permissions.mjs', 'scripts/native-adapter-split.mjs', 'scripts/lib/native-adapter-split.mjs', 'scripts/lib/native-adapter-split-compare.mjs', '.github/workflows/report-scheduled-failure.yml', ...crateClosure(REPO).map((dir) => `${dir}/Cargo.toml`)];
  // The bisect workflow is optional, so a revert of it reads as an audit failure, not a copy error.
  if (existsSync(join(REPO, BISECT))) files.push(BISECT);
  for (const f of files) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    cpSync(join(REPO, f), join(root, f));
  }
  return root;
}
const mutate = (root, fn, file = WORKFLOW) => {
  const path = join(root, file);
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

test('a narrow entry under .cargo/ does not cover the whole directory', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replaceAll("      - '.cargo/**'\n", "      - '.cargo/x/x'\n"));
  assert.ok(audit(root).some((f) => f.includes('.cargo/** is not covered by on.pull_request.paths')));
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
  mutate(cancelsNightly, (t) => t.replace(`cancel-in-progress: \${{ github.event_name == 'pull_request' && !inputs.batch }}`, 'cancel-in-progress: true'));
  assert.ok(audit(cancelsNightly).some((f) => f.includes('concurrency must be per-PR')));
  // A batch keyed on its PR number could be cancelled by, or cancel, a labelled run of the batch PR.
  const batchByNumber = copyTree(context);
  // GitHub Actions expressions, replaced as written.
  // eslint-disable-next-line no-template-curly-in-string
  mutate(batchByNumber, (t) => t.replace('geometry-platform-${{ !inputs.batch && github.event.pull_request.number || github.run_id }}', 'geometry-platform-${{ github.event.pull_request.number || github.run_id }}'));
  assert.ok(audit(batchByNumber).some((f) => f.includes('concurrency must be per-PR')));
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
  mutate(ungated, (t) => t.replace("    if: (inputs.bisect_sha && inputs.bisect_shards) || github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120", "    runs-on: ubuntu-24.04\n    timeout-minutes: 120"));
  assert.ok(audit(ungated).some((f) => f.includes('native-corpus must be gated')));
  const unbounded = copyTree(context);
  mutate(unbounded, (t) => t.replace('    timeout-minutes: 120\n    strategy:', '    timeout-minutes: 400\n    strategy:'));
  assert.ok(audit(unbounded).some((f) => f.includes('360-minute')));
});

test('a product-table merge without the shard count is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('corpus-shards.mjs merge --shards 8 ', 'corpus-shards.mjs merge '));
  assert.ok(audit(root).some((f) => f.includes('product-table merge')));
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
  mutate(root, (t) => t.replace('    needs: [native-corpus]\n', '    needs: []\n').replace('          [[ "$SHARDS_RESULT" == success ]]\n', '').replace('needs: [nightly-range, native-adapter, native-corpus-result]\n    if: always() && github.event_name', 'needs: [nightly-range, native-adapter]\n    if: always() && github.event_name'));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('must need native-corpus')));
  assert.ok(failures.some((f) => f.includes('matrix result is not success')));
  assert.ok(failures.some((f) => f.includes('report-scheduled-failure must need nightly-range, native-adapter and native-corpus-result')));
});

test('an aggregate that stops reporting the models left out of the corpus is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace(/      - name: Report models that were not checked\n        if: always\(\)\n        run: [^\n]*\n/, ''));
  assert.ok(audit(root).some((f) => f.includes('must report the models excluded from the corpus')));
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
  mutate(root, (t) => t.replace(/        shard: \$\{\{ fromJSON\(inputs\.bisect_shards \|\| '\[[0-9, ]+\]'\) \}\}\n/, `        shard: \${{ fromJSON('[0,1]') }}\n`));
  const failures = audit(root);
  assert.ok(failures.some((f) => f.includes('listing 0..N-1 in order')));
  assert.ok(!failures.some((f) => f.includes('(0)') || f.includes('exactly the matrix\'s 0')), failures.join('\n'));
});

// ------------------------------------------------------------ merge-queue batches

test('the copied tree audits clean, so each mutation below is the only failure source', (context) => {
  assert.deepEqual(audit(copyTree(context)), []);
});

test('a batch call that loses its input, its gate or its corpus exclusion is reported', (context) => {
  const noInput = copyTree(context);
  mutate(noInput, (t) => t.replace(/  workflow_call:\n(?: {4,}.*\n)+/, ''));
  assert.ok(audit(noInput).some((f) => f.includes('on.workflow_call must declare a boolean `batch` input')));
  const corpus = copyTree(context);
  mutate(corpus, (t) => t.replace('  workflow_call:\n    inputs:\n', '  workflow_call:\n    inputs:\n      corpus:\n        type: boolean\n'));
  assert.ok(audit(corpus).some((f) => f.includes('must not accept `corpus`')));
  const ungated = copyTree(context);
  mutate(ungated, (t) => t.replace('      inputs.batch == true ||\n', ''));
  assert.ok(audit(ungated).some((f) => f.includes('must keep its opt-in gate')));
});

test('test.yml must call, decide and judge the batch run', (context) => {
  const cases = [
    [(t) => t.replace(/\n  native-adapter:\n(?: {4}.*\n|\s*\n)+?(?=  test:)/, '\n'), 'no native-adapter job'],
    [(t) => t.replace('    with:\n      batch: true\n', ''), 'with batch: true'],
    // Polarity: `== 'true'` would skip the lane whenever the decision step crashed.
    [(t) => t.replace("needs.changes.outputs.native_adapter != 'false'", "needs.changes.outputs.native_adapter == 'true'"), 'only an explicit `false` skips'],
    [(t) => t.replace("needs.changes.outputs.batch == 'true' && needs.changes.outputs.noop", "needs.changes.outputs.noop"), 'gated on exactly'],
    [(t) => t.replace(/      native_adapter: \$\{\{ steps\.nativeadapter\.outputs\.native_adapter \}\}\n/, ''), 'must publish native_adapter'],
    [(t) => t.replace(/(        id: nativeadapter\n(?: {8}.*\n)*?) {8}continue-on-error: true\n/, '$1'), 'continue-on-error step with id nativeadapter'],
    [(t) => t.replace(', release-pr, native-adapter]', ', release-pr]'), 'aggregate must need native-adapter'],
    // A crashed lane step once left batch at 'false' and skipped the lane.
    [(t) => t.replace(" || (startsWith(github.head_ref, 'mergify/merge-queue/') && 'true' || 'false') }}", " || 'false' }}"), 'must fall back on the mergify/merge-queue/ head ref'],
    // The caller once granted contents+issues only, after the reporter gained `actions: read`.
    [(t) => t.replace('      actions: read\n      contents: read\n      issues: write\n    uses: ./.github/workflows/geometry-platform.yml', '      contents: read\n      issues: write\n    uses: ./.github/workflows/geometry-platform.yml'), 'must grant actions: read'],
  ];
  // The callee's own permissions, in each form the grant check must not pass over.
  for (const [fn, expected] of [
    [(t) => t.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  pull-requests: write\n'), 'must grant pull-requests: write'],
    [(t) => t.replace('    permissions:\n      actions: read\n      contents: read\n      issues: write\n', '    permissions: write-all\n'), 'cannot judge `permissions: write-all`'],
    [(t) => t.replace('    permissions:\n      actions: read\n', '    permissions:\n      { actions: read }\n'), 'cannot judge permissions entry'],
  ]) {
    const root = copyTree(context);
    mutate(root, fn);
    const failures = audit(root);
    assert.ok(failures.some((f) => f.includes(expected)), `${expected}:\n${failures.join('\n')}`);
  }
  for (const [fn, expected] of cases) {
    const root = copyTree(context);
    mutate(root, fn, TEST_WORKFLOW);
    const failures = audit(root);
    assert.ok(failures.some((f) => f.includes(expected)), `${expected}:\n${failures.join('\n')}`);
  }
});

test('permissionBlocks reads every spelling of a block and fails closed on the rest', () => {
  const parse = (wf) => {
    const out = [];
    return { blocks: permissionBlocks(wf, out, 'w.yml'), out };
  };
  const scopes = (wf) => parse(wf).blocks.map((b) => b.scopes);
  assert.deepEqual(scopes('permissions:\n  contents: read\njobs:\n  a:\n    permissions:\n      issues: write # why\n'), [{ contents: 'read' }, { issues: 'write' }]);
  assert.deepEqual(scopes('jobs:\n  a:\n    "permissions" :\n      "pull-requests": \'write\'\n'), [{ 'pull-requests': 'write' }]);
  assert.deepEqual(scopes('jobs:\n  a:\n    permissions: {}\n'), [{}]);
  // A comment that looks like a block scalar opens nothing; anchors and tags are keys.
  assert.deepEqual(scopes('jobs:\n# usage: |\n  a: # note: >\n    permissions:\n      contents: write\n'), [{ contents: 'write' }]);
  assert.deepEqual(scopes('jobs:\n  a:\n    &p permissions:\n      issues: write\n  b:\n    !!str permissions:\n      actions: read\n'), [{ issues: 'write' }, { actions: 'read' }]);
  // Step names and one-line commands that mention permissions are not keys.
  assert.deepEqual(parse('jobs:\n  a:\n    steps:\n      - name: Check token permissions\n        run: echo "verify permissions: ok"\n').out, []);
  // A tagged script is a script.
  assert.deepEqual(parse('jobs:\n  a:\n    steps:\n      - run: !!str |\n          permissions:\n            issues: write\n').blocks, []);
  // A sequence-item script is skipped like a `run: |` one.
  assert.deepEqual(parse('jobs:\n  a:\n    with:\n      args:\n        - |\n          permissions:\n            issues: write\n').blocks, []);
  // A run script mentioning permissions is not a block.
  assert.deepEqual(parse('jobs:\n  a:\n    steps:\n      - run: |\n          cat <<X\n          permissions:\n            pull-requests: write\n          X\n').blocks, []);
  for (const [wf, expected] of [
    ['jobs:\n  a:\n    permissions: write-all\n', 'cannot judge `permissions: write-all`'],
    ['jobs:\n  a:\n    permissions:\n      { actions: read }\n', 'cannot judge permissions entry'],
    ['jobs:\n  a: { runs-on: x, permissions: { issues: write } }\n', 'spell permissions out as a block'],
    ['jobs:\n  a:\n    ? permissions\n    : { issues: write }\n', 'spell permissions out as a block'],
  ]) assert.ok(parse(wf).out.some((f) => f.includes(expected)), `${expected}: ${parse(wf).out}`);
});

test('permissionBlocks agrees with a YAML parser on every workflow in the repo', () => {
  // The guard runs before pnpm install, so it reads lines; the tests have yaml.
  const dir = join(REPO, '.github/workflows');
  for (const name of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const ymlText = readFileSync(join(dir, name), 'utf8');
    const doc = parseYaml(ymlText);
    const parsed = [doc.permissions, ...Object.values(doc.jobs ?? {}).map((j) => j?.permissions)].filter((p) => p !== undefined);
    const problems = [];
    const { blocks, calls } = scan(ymlText, problems, name);
    const lines = blocks.map((b) => b.scopes);
    // Every local reusable call a parser sees, the scan follows.
    // @source-text-assertion-ok filters a YAML parser's job values to local calls; the assertion compares those with the scan
    const parsedCalls = Object.values(doc.jobs ?? {}).map((j) => j?.uses).filter((u) => typeof u === 'string' && u.startsWith('./.github/workflows/')).map((u) => u.slice(2));
    assert.deepEqual(calls, parsedCalls, `${name}: calls`);
    const scalars = parsed.filter((p) => typeof p !== 'object' || p === null).length;
    assert.equal(problems.length, scalars, `${name}: exactly the scalar permissions values are reported: ${problems}`);
    assert.deepEqual(lines, parsed.filter((p) => typeof p === 'object' && p !== null), name);
  }
});

test('the call\'s own grant is the block at job level, and it must be readable', (context) => {
  const grant = '    permissions:\n      actions: read\n      contents: read\n      issues: write\n    uses: ./.github/workflows/geometry-platform.yml';
  for (const [fn, expected] of [
    [(t) => t.replace(grant, '    permissions: write-all\n    uses: ./.github/workflows/geometry-platform.yml'), 'cannot judge `permissions: write-all`'],
    [(t) => t.replace(grant, '    uses: ./.github/workflows/geometry-platform.yml'), 'must grant issues: write'],
    [(t) => t.replace(grant, grant.replace('issues: write', 'issues: none')), 'must grant issues: write'],
  ]) {
    const root = copyTree(context);
    mutate(root, fn, TEST_WORKFLOW);
    const failures = audit(root);
    assert.ok(failures.some((f) => f.includes(expected)), `${expected}:\n${failures.join('\n')}`);
  }
  // A local reusable workflow the callee calls is held to the same grant.
  const nested = copyTree(context);
  mutate(nested, (t) => t.replace('permissions:\n  actions: read\n', 'permissions:\n  pull-requests: write\n  actions: read\n'), '.github/workflows/report-scheduled-failure.yml');
  const nestedFailures = audit(nested);
  assert.ok(nestedFailures.some((f) => f.includes('must grant pull-requests: write')), nestedFailures.join('\n'));
  const missing = copyTree(context);
  rmSync(join(missing, '.github/workflows/report-scheduled-failure.yml'));
  const missingFailures = audit(missing);
  assert.ok(missingFailures.some((f) => f.includes('cannot read .github/workflows/report-scheduled-failure.yml')), missingFailures.join('\n'));
  // Two levels down, and a cycle ends.
  const deep = copyTree(context);
  mutate(deep, (t) => `${t}  again:\n    uses: ./.github/workflows/deeper.yml\n`, '.github/workflows/report-scheduled-failure.yml');
  writeFileSync(join(deep, '.github/workflows/deeper.yml'), 'permissions:\n  pull-requests: write\njobs:\n  loop:\n    uses: ./.github/workflows/report-scheduled-failure.yml\n');
  const deepFailures = audit(deep);
  assert.ok(deepFailures.some((f) => f.includes('must grant pull-requests: write')), deepFailures.join('\n'));
  // A call with quotes and a trailing comment is followed; one inside a script is not.
  const quoted = copyTree(context);
  mutate(quoted, (t) => t.replace('    uses: ./.github/workflows/report-scheduled-failure.yml\n', '    uses: "./.github/workflows/report-scheduled-failure.yml" # nightly issue\n'));
  mutate(quoted, (t) => t.replace('permissions:\n  actions: read\n', 'permissions:\n  pull-requests: write\n  actions: read\n'), '.github/workflows/report-scheduled-failure.yml');
  const quotedFailures = audit(quoted);
  assert.ok(quotedFailures.some((f) => f.includes('must grant pull-requests: write')), quotedFailures.join('\n'));
  const scripted = copyTree(context);
  mutate(scripted, (t) => `${t}  echo:\n    runs-on: x\n    steps:\n      - run: |\n          uses: ./.github/workflows/not-there.yml\n`, '.github/workflows/report-scheduled-failure.yml');
  mutate(scripted, (t) => t.replace('permissions:\n  actions: read\n', 'permissions:\n  pull-requests: write\n  actions: read\n'), '.github/workflows/report-scheduled-failure.yml');
  const scriptedFailures = audit(scripted);
  assert.equal(scriptedFailures.some((f) => f.includes('not-there')), false, scriptedFailures.join('\n'));
  // The real call is still followed past the script.
  assert.ok(scriptedFailures.some((f) => f.includes('must grant pull-requests: write')), scriptedFailures.join('\n'));
  // A call it cannot follow is reported, not skipped.
  for (const spelling of ['uses: LTplus-AG/ifc-lite/.github/workflows/report-scheduled-failure.yml@main', 'uses: >-']) {
    const other = copyTree(context);
    mutate(other, (t) => t.replace('    uses: ./.github/workflows/report-scheduled-failure.yml\n', `    ${spelling}\n`));
    assert.ok(audit(other).some((f) => f.includes('cannot follow')), spelling);
  }
  const flowProblems = [];
  assert.deepEqual(scan('jobs:\n  a: { needs: [b], uses: ./.github/workflows/x.yml }\n', flowProblems, 'w').calls, []);
  assert.ok(flowProblems.some((f) => f.includes('cannot follow')), flowProblems.join('\n'));
  // A quoted key is the same key, and is followed.
  for (const key of ['"uses"', "'uses'"]) {
    assert.deepEqual(scan(`jobs:\n  a:\n    ${key}: ./.github/workflows/x.yml\n`, [], 'w').calls, ['.github/workflows/x.yml'], key);
  }
  // A trailing comment is not part of the call.
  assert.deepEqual(scan('jobs:\n  a:\n    uses: ./.github/workflows/x.yml # note\n', [], 'w').calls, ['.github/workflows/x.yml']);
});

// ------------------------------------------------------------ the nightly route (what covers #10619's excluded paths)

test('a nightly route that loses its schedule, record, range-carrying report or bisect is reported', (context) => {
  const cases = [
    ['no schedule', (t) => t.replace("  schedule:\n    - cron: '30 2 * * *'\n", ''), 'on.schedule'],
    ['corpus off the nightly', (t) => t.replace(" || github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true)\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120", "\n    runs-on: ubuntu-24.04\n    timeout-minutes: 120"), 'native-corpus must be gated'],
    ['no record', (t) => t.replace(/  nightly-range:\n[\s\S]*?(?=\n {2}# One tracking issue)/, ''), 'no nightly-range job'],
    ['record gated only on a step', (t) => {
      const job = t.slice(t.indexOf('  nightly-range:\n'));
      const gateLine = job.split('\n').find((l) => l.startsWith('    if: '));
      assert.ok(gateLine, 'nightly-range has a job-level if:');
      return t.replace(`  nightly-range:\n    name: Nightly coverage range\n${gateLine}\n`, '  nightly-range:\n    name: Nightly coverage range\n').replace('      - name: Name the commits this run covers\n', `      - name: Name the commits this run covers\n        ${gateLine.trim()}\n`);
    }, 'nightly-range must run on every full run'],
    ['range step switched off', (t) => t.replace('      - name: Name the commits this run covers\n', '      - name: Name the commits this run covers\n        if: false\n'), 'neither step gated by its own if:'],
    ['record upload switched off', (t) => t.replace('      - name: Keep the coverage record for the bisect\n', '      - name: Keep the coverage record for the bisect\n        if: false\n'), 'neither step gated by its own if:'],
    ['full clone on another step', (t) => t.replace('          fetch-depth: 0\n          filter: blob:none\n      - name: Name the commits', '          filter: blob:none\n      - name: Name the commits').replace('      - name: Keep the coverage record for the bisect\n', '      - name: Other\n        uses: some/action@v1\n        with:\n          fetch-depth: 0\n      - name: Keep the coverage record for the bisect\n'), 'fetch-depth: 0 on its checkout'],
    ['record off main', (t) => t.replace("    if: github.ref == 'refs/heads/main' && (", "    if: (github.ref == 'refs/heads/main' || true) && ("), 'nightly-range must run on every full run'],
    ['record behind the lane', (t) => t.replace('    name: Nightly coverage range\n', '    name: Nightly coverage range\n    needs: [native-adapter]\n'), 'must not need another job'],
    ['record never uploaded', (t) => t.replace(`          path: \${{ runner.temp }}/nightly-range.json\n`, `          path: \${{ runner.temp }}/other.json\n`), 'upload nightly-range.json as the nightly-range artifact'],
    ['record under another artifact name', (t) => t.replace('          name: nightly-range\n          path:', '          name: other\n          path:'), 'upload nightly-range.json as the nightly-range artifact'],
    ['shallow record', (t) => t.replace('          fetch-depth: 0\n          filter: blob:none\n      - name: Name the commits', '          filter: blob:none\n      - name: Name the commits'), 'fetch-depth: 0'],
    ['report without the range', (t) => t.replace(`      detail: \${{ needs.nightly-range.outputs.detail }}\n`, ''), 'must pass the nightly-range detail'],
    ['report without the label', (t) => t.replace('      labels: nightly-red\n', ''), 'labels: nightly-red'],
    ['report ignores the record', (t) => t.replace("needs.nightly-range.result != 'success' || needs.native-adapter", 'needs.native-adapter'), 'must report a red nightly-range'],
    ['renamed corpus aggregate', (t) => t.replace('    name: Native corpus result\n', '    name: Corpus result\n'), 'must keep the names the coverage record reads'],
    ['renamed workflow', (t) => t.replace('name: Geometry platform (native adapter)\n', 'name: Geometry platform\n'), "its name must stay 'Geometry platform (native adapter)'"],
  ];
  cases.push(...[
    ['no trigger', (t) => t.replace("    workflows: ['Geometry platform (native adapter)']\n", "    workflows: ['Geometry platform']\n"), 'must start on workflow_run'],
    ['probe at the wrong commit', (t) => t.replace(`      bisect_sha: \${{ needs.plan.outputs.probe }}\n`, ''), 'the probe job must call'],
    ['probe under-granted', (t) => t.replace(`    with:\n      bisect_sha: \${{ needs.plan.outputs.probe }}\n      bisect_adapter: \${{ needs.plan.outputs.adapter == 'true' }}\n      bisect_shards: \${{ needs.plan.outputs.shards }}\n    # Everything geometry-platform.yml asks for, or GitHub refuses the run.\n    permissions:\n      actions: read\n      contents: read\n      issues: write\n`, `    with:\n      bisect_sha: \${{ needs.plan.outputs.probe }}\n    permissions:\n      contents: read\n`), 'must grant issues: write'],
  ].map(([name, fn, expected]) => [name, fn, expected, BISECT]));
  for (const [name, fn, expected, file = WORKFLOW] of cases) {
    const root = copyTree(context);
    mutate(root, (t) => {
      const out = fn(t);
      assert.notEqual(out, t, `${name}: the mutation did not apply`);
      return out;
    }, file);
    const failures = audit(root);
    assert.ok(failures.some((f) => f.includes(expected)), `${name}: ${failures.join('\n')}`);
  }
  const gone = copyTree(context);
  rmSync(join(gone, BISECT));
  assert.ok(audit(gone).some((f) => f.includes('native-adapter-bisect.yml is missing')));
});

test('an equivalent nightly-range gate folded into a >- block still audits clean', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => {
    const out = t.replace("    if: github.ref == 'refs/heads/main' && (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true))\n", "    if: >-\n      github.ref == 'refs/heads/main' &&\n      (github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.corpus == true))\n");
    assert.notEqual(out, t, 'the mutation did not apply');
    return out;
  });
  assert.deepEqual(audit(root), []);
});

test('a bisect probe that would run the adapter it was not asked for is reported', (context) => {
  const root = copyTree(context);
  mutate(root, (t) => t.replace('      (!inputs.bisect_sha || inputs.bisect_adapter) && (\n', '      (\n'));
  assert.ok(audit(root).some((f) => f.includes('a bisect probe only with bisect_adapter')));
});

// ------------------------------------------------------------ the split lane (shadow phase)

/** Replaces `from` with `to` inside one top-level job only (`to` null drops the job). Each test's own assertion fails if it did not apply. */
const inJob = (root, id, from, to) => mutate(root, (t) => {
  const block = jobBlock(t, id);
  return to === null ? t.replace(`  ${id}:\n${block}`, '') : t.replace(`  ${id}:\n${block}`, `  ${id}:\n${block.replace(from, to)}`);
});

test('a split lane job that loses the opt-in gate or the shadow switch is reported', (context) => {
  const noShadow = copyTree(context);
  inJob(noShadow, 'na-wasm', " && vars.NATIVE_ADAPTER_SPLIT == 'shadow'\n", '\n');
  assert.ok(audit(noShadow).some((f) => f.includes('split job na-wasm must be gated on exactly')));
  const noBisect = copyTree(context);
  inJob(noBisect, 'na-viewer', '      !cancelled() && (!inputs.bisect_sha || inputs.bisect_adapter) && (\n', '      !cancelled() && (\n');
  assert.ok(audit(noBisect).some((f) => f.includes('split job na-viewer must be gated on exactly')));
  // A downstream job without !cancelled() is skipped whenever any upstream job fails.
  const noCancelled = copyTree(context);
  inJob(noCancelled, 'na-browser', '      !cancelled() && (!inputs.bisect_sha', '      (!inputs.bisect_sha');
  assert.ok(audit(noCancelled).some((f) => f.includes('split job na-browser must be gated on exactly')));
});

test('a split lane job sharing the single job\'s concurrency group, or cancelling a nightly, is reported', (context) => {
  const shared = copyTree(context);
  inJob(shared, 'na-native', 'group: geometry-platform-na-native-', 'group: geometry-platform-');
  assert.ok(audit(shared).some((f) => f.includes('split job na-native needs its own job-level concurrency group')));
  const cancels = copyTree(context);
  inJob(cancels, 'na-split-judge', `cancel-in-progress: \${{ github.event_name == 'pull_request' && !inputs.batch }}`, 'cancel-in-progress: true');
  assert.ok(audit(cancels).some((f) => f.includes('split job na-split-judge needs its own job-level concurrency group')));
});

test('a split job that checks out the event commit on a bisect probe is reported', (context) => {
  const root = copyTree(context);
  inJob(root, 'na-cli-parity', '          ref: ${{ inputs.bisect_sha }}\n', '');
  assert.ok(audit(root).some((f) => f.includes('every checkout of this repository in split job na-cli-parity must use ref')));
});

test('a split job that runs the corpus, or a script that cannot trigger the lane, is reported', (context) => {
  const corpus = copyTree(context);
  inJob(corpus, 'na-native', '--committed --gate', '--manifest tests/models/manifest.json');
  assert.ok(audit(corpus).some((f) => f.includes('na-native runs the corpus itself')));
  const script = copyTree(context);
  inJob(script, 'na-wasm', 'run: node --test packages/wasm/test/retained-browser.test.mjs', 'run: node scripts/zz-untriggered-split-probe.mjs');
  assert.ok(audit(script).some((f) => f.includes('scripts/zz-untriggered-split-probe.mjs is run by')));
  const lib = copyTree(context);
  mutate(lib, (t) => t.replaceAll("      - 'scripts/lib/native-adapter-split-compare.mjs'\n", ''));
  assert.ok(audit(lib).some((f) => f.includes('scripts/lib/native-adapter-split-compare.mjs is run by')));
});

test('a partial split, a judge that misses a lane job or a lane step that is fatal is reported', (context) => {
  const partial = copyTree(context);
  inJob(partial, 'na-split-compare', '', null);
  assert.ok(audit(partial).some((f) => f.includes('split is partial; missing job(s) na-split-compare')));
  const judge = copyTree(context);
  inJob(judge, 'na-split-judge', ', na-cli-parity]', ']');
  assert.ok(audit(judge).some((f) => f.includes('split job na-split-judge must need exactly')));
  const fatal = copyTree(context);
  inJob(fatal, 'na-native', '        id: finish-join\n        continue-on-error: true\n', '        id: finish-join\n');
  assert.ok(audit(fatal).some((f) => f.includes('must run lane step finish-join with continue-on-error')));
  const noVerdict = copyTree(context);
  inJob(noVerdict, 'na-emscripten', '      verdict: ${{ steps.verdict.outputs.verdict }}\n', '');
  assert.ok(audit(noVerdict).some((f) => f.includes('split job na-emscripten must end with an if: always() step id verdict')));
});

test('split artifacts stay namespaced, and split Rust caches restore the single job\'s, read-only', (context) => {
  const artifact = copyTree(context);
  inJob(artifact, 'na-wasm', 'name: na-split-wasm-pkg', 'name: wasm-pkg');
  assert.ok(audit(artifact).some((f) => f.includes("split job na-wasm uploads 'wasm-pkg'")));
  // The Actions cache is at its limit: the shadow phase restores the single job's cache and writes none.
  const saves = copyTree(context);
  inJob(saves, 'na-browser', "          save-if: 'false'\n", '');
  assert.ok(audit(saves).some((f) => f.includes("split job na-browser must restore its Rust cache only (setup-wasm-build save-if: 'false')")));
  const ownKey = copyTree(context);
  inJob(ownKey, 'na-native', "          save-if: 'false'\n", "          save-if: 'false'\n          shared-key: main-na-native\n");
  assert.ok(audit(ownKey).some((f) => f.includes("split job na-native must restore the single job's Rust cache")));
  // A change to the single job's cache (#10851's pinned adapter key) must reach the split too.
  const monoMoved = copyTree(context);
  inJob(monoMoved, 'native-adapter', '          cache-prefix: geometry-platform\n', '          cache-prefix: geometry-platform-adapter-v1\n');
  assert.ok(audit(monoMoved).some((f) => f.includes("split job na-wasm must restore the single job's Rust cache")));
});

test('the split lane map must cover exactly the single job\'s judged lanes', (context) => {
  const root = copyTree(context);
  inJob(root, 'native-adapter', 'for lane in HALFSPACE_GENERATED ', 'for lane in NEW_LANE HALFSPACE_GENERATED ');
  assert.ok(audit(root).some((f) => f.includes('LANES in scripts/lib/native-adapter-split.mjs must map exactly')));
});
