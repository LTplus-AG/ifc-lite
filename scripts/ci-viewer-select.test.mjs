/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Selected viewer tests on a fast-lane PR: the switch, the classification of
 * changed files (unmappable ones select nothing), the budgeted sample, the CLI
 * over a real git checkout, and the test.yml wiring.
 *
 * Run: node --test scripts/ci-viewer-select.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import {
  BUDGET_SECONDS, classifyChanges, decideViewerSelect, parseNameStatus, preloadsFromTestScript, runnerArgs,
  sampleWithinBudget, unmappableReason,
} from './ci-viewer-select.mjs';
import { buildGraph, createResolver } from './lib/viewer-import-graph.mjs';
import { UNJUDGED_BY_DESIGN, readAggregate, unwatched } from './check-ci-aggregate-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const CLI = join(HERE, 'ci-viewer-select.mjs');
const TMP = mkdtempSync(join(tmpdir(), 'ci-viewer-select-'));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------- the switch

const PR = (mode, over = {}) => decideViewerSelect({ mode, event: 'pull_request', lane: 'fast', headRef: 'feat/x', noop: 'false', ...over });

test('unset, `off` and any unrecognised value select nothing', () => {
  for (const mode of [undefined, '', 'off', 'OFF', 'true', 'yes', ' on', 'on ', 'shadwo']) {
    const d = PR(mode);
    assert.equal(d.mode, 'off', JSON.stringify(mode));
    assert.equal(d.select, false);
    assert.equal(d.runTests, false);
  }
  assert.equal(PR(undefined).warning, undefined, 'unset is not a typo');
  assert.match(PR('shadwo').warning ?? '', /not one of off, shadow, on/); // @source-text-assertion-ok subject is the decision's returned message, not a source file
});

test('`shadow` selects without running; `on` selects and runs; case-insensitive like Actions `==`', () => {
  assert.deepEqual([PR('shadow').select, PR('shadow').runTests], [true, false]);
  assert.deepEqual([PR('on').select, PR('on').runTests], [true, true]);
  assert.equal(PR('On').runTests, true);
});

test('never selects on merge_group, push, a Mergify batch, a no-op edit replay or the full lane', () => {
  const cases = [
    { event: 'merge_group' }, { event: 'push' }, { event: undefined },
    { headRef: 'mergify/merge-queue/abc' },
    { noop: 'true' },
    { lane: 'full' }, { lane: '' }, { lane: undefined }, { lane: 'FAST?' },
  ];
  for (const mode of ['shadow', 'on']) {
    for (const c of cases) assert.equal(PR(mode, c).select, false, `${mode} ${JSON.stringify(c)}`);
  }
});

// ---------------------------------------------------------------- classification

const SRC = {
  'apps/viewer/src/a.test.ts': "import './lib/util.js';\nimport '@ifc-lite/wasm';",
  'apps/viewer/src/b.test.ts': "import './lib/gone.js';\nimport './old-dir';",
  'apps/viewer/src/lib/util.ts': '',
  'packages/cli/src/index.ts': '',
};
const PACKAGES = new Map([['@ifc-lite/wasm', { dir: 'packages/wasm', exports: { '.': './pkg/x.js' } }], ['@ifc-lite/cli', { dir: 'packages/cli' }]]);
const GRAPH = buildGraph({
  tests: ['apps/viewer/src/a.test.ts', 'apps/viewer/src/b.test.ts'],
  read: (p) => SRC[p],
  resolve: createResolver({ files: new Set(Object.keys(SRC)), packages: PACKAGES }),
});
const classify = (...changes) => classifyChanges(changes.map((c) => (typeof c === 'string' ? { status: 'M', path: c } : c)), GRAPH, PACKAGES);

test('a file in the graph is a seed; a deletion seeds the files that still import it', () => {
  const { rows, seeds } = classify('apps/viewer/src/lib/util.ts', { status: 'D', path: 'apps/viewer/src/lib/gone.ts' });
  assert.deepEqual(rows.map((r) => r.class), ['graph', 'graph']);
  assert.deepEqual([...seeds].sort(), ['apps/viewer/src/b.test.ts', 'apps/viewer/src/lib/util.ts']);
});

test('deleting a directory\'s index maps to the files importing the directory', () => {
  const { rows, seeds } = classify({ status: 'D', path: 'apps/viewer/src/old-dir/index.ts' });
  assert.equal(rows[0].class, 'graph');
  assert.deepEqual([...seeds], ['apps/viewer/src/b.test.ts']);
});

test('UNMAPPABLE changes select nothing and each carries a reason', () => {
  const unmappable = [
    'pnpm-lock.yaml',
    'package.json',
    'apps/viewer/package.json',
    'apps/viewer/tsconfig.json',
    'apps/viewer/vite.config.ts',
    'turbo.json',
    'rust/core/src/lib.rs',
    'Cargo.lock',
    'packages/wasm/pkg/ifc-lite.d.ts',
    '.github/workflows/test.yml',
    'scripts/viewer-test-shards.mjs',
    'apps/viewer/test-durations.json',
    'apps/viewer/src/test/fixtures/model.ifc',
    'packages/parser/src/generated/schema.bin',
    'docs/guide/viewer.md',
    { status: 'D', path: 'apps/viewer/src/lib/never-imported.ts' },
  ];
  const { rows, seeds } = classify(...unmappable);
  assert.equal(seeds.size, 0, 'an unmappable change must not seed the selection');
  const byPath = Object.fromEntries(rows.map((r) => [r.path, r]));
  for (const r of rows) assert.ok(r.reason.length > 0, r.path);
  for (const p of ['pnpm-lock.yaml', 'rust/core/src/lib.rs', 'apps/viewer/src/test/fixtures/model.ifc', '.github/workflows/test.yml']) {
    assert.equal(byPath[p].class, 'unmapped', p);
  }
  assert.match(byPath['rust/core/src/lib.rs'].reason, /WASM or Rust/); // @source-text-assertion-ok subject is the classifier's returned reason, not a source file
  assert.match(byPath['packages/wasm/pkg/ifc-lite.d.ts'].reason, /WASM or Rust/); // @source-text-assertion-ok subject is the classifier's returned reason, not a source file
  assert.match(byPath['pnpm-lock.yaml'].reason, /configuration/); // @source-text-assertion-ok subject is the classifier's returned reason, not a source file
  assert.match(byPath['apps/viewer/src/test/fixtures/model.ifc'].reason, /read at runtime/); // @source-text-assertion-ok subject is the classifier's returned reason, not a source file
  assert.equal(byPath['apps/viewer/src/lib/never-imported.ts'].class, 'unreached');
});

test('the WASM package\'s sources do not map through its opaque node; Rust changes stay unmapped', () => {
  // `pkg:@ifc-lite/wasm` is in the graph, but nothing under packages/wasm is a
  // source the graph can follow: it is built from Rust.
  assert.equal(classify('packages/wasm/src/index.ts').seeds.size, 0);
});

test('a source file no viewer test imports is reported, not silently dropped', () => {
  const { rows, seeds } = classify('packages/cli/src/index.ts');
  assert.equal(seeds.size, 0);
  assert.equal(rows[0].class, 'unreached');
});

test('unmappableReason has a reason for any path at all', () => {
  for (const p of ['README.md', 'x', 'apps/other/foo.ts']) assert.ok(unmappableReason(p).length > 0, p);
});

// ---------------------------------------------------------------- the budget

const t = (n) => `apps/viewer/src/t${n}.test.ts`;

test('the sample keeps the nearest tests first and stops at the budget', () => {
  const affected = new Map([[t(1), 3], [t(2), 0], [t(3), 1], [t(4), 2]]);
  const seconds = { 'src/t1.test.ts': 10, 'src/t2.test.ts': 10, 'src/t3.test.ts': 10, 'src/t4.test.ts': 10 };
  const s = sampleWithinBudget(affected, seconds, 25);
  assert.deepEqual(s.ran, [t(2), t(3)]);
  assert.deepEqual(new Set(s.leftOut), new Set([t(4), t(1)]));
  assert.equal(s.estimatedSeconds, 20);
});

test('an oversize test is left out and smaller later ones still fill the budget', () => {
  const affected = new Map([[t(1), 0], [t(2), 1], [t(3), 2]]);
  const s = sampleWithinBudget(affected, { 'src/t1.test.ts': 5, 'src/t2.test.ts': 500, 'src/t3.test.ts': 5 }, 20);
  assert.deepEqual(s.ran, [t(1), t(3)]);
  assert.deepEqual(s.leftOut, [t(2)]);
});

test('an unmeasured test costs the manifest median; the sample is deterministic', () => {
  const affected = new Map(Array.from({ length: 50 }, (_, i) => [t(i), i % 3]));
  const seconds = { 'src/a.test.ts': 2, 'src/b.test.ts': 4, 'src/c.test.ts': 6 };
  const a = sampleWithinBudget(affected, seconds, 40);
  assert.equal(a.fallbackSeconds, 4);
  assert.equal(a.ran.length, 10);
  assert.equal(a.ran.length + a.leftOut.length, 50);
  assert.deepEqual(sampleWithinBudget(new Map([...affected].reverse()), seconds, 40), a, 'input order does not matter');
});

test('the default budget is near ten minutes of job time', () => {
  assert.ok(BUDGET_SECONDS >= 300 && BUDGET_SECONDS <= 480);
});

// ---------------------------------------------------------------- inputs read from the repo

test('parseNameStatus reads `git diff --name-status -z`', () => {
  assert.deepEqual(parseNameStatus('M\0a.ts\0D\0b c.ts\0A\0d.ts\0'), [
    { status: 'M', path: 'a.ts' }, { status: 'D', path: 'b c.ts' }, { status: 'A', path: 'd.ts' },
  ]);
  assert.deepEqual(parseNameStatus(''), []);
});

const VIEWER_TEST_SCRIPT = JSON.parse(readFileSync(join(REPO_ROOT, 'apps/viewer/package.json'), 'utf8')).scripts.test;

test('the preloads and the runner come from the viewer test script itself', () => {
  const preloads = preloadsFromTestScript(VIEWER_TEST_SCRIPT);
  assert.ok(preloads.length > 0, 'the viewer test script preloads its module hooks');
  for (const p of preloads) assert.ok(existsSync(join(REPO_ROOT, p)), `${p} exists`);
  const args = runnerArgs(VIEWER_TEST_SCRIPT);
  assert.equal(args[0], 'tsx');
  assert.ok(args.includes('--test')); // @source-text-assertion-ok subject is the parsed argv of the viewer test command, which the --run step executes
  assert.ok(args.includes('--test-concurrency=1'), 'serial, like the shards'); // @source-text-assertion-ok subject is the parsed argv of the viewer test command, which the --run step executes
  assert.throws(() => runnerArgs('vitest run'), /cannot find/);
});

// ---------------------------------------------------------------- the CLI over a git checkout

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(root, files) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

/** A minimal repo: a.test.ts imports util directly, b.test.ts through mid.ts; then one commit of `change`. */
function fixtureRepo(change) {
  const root = mkdtempSync(join(TMP, 'repo-'));
  write(root, {
    'apps/viewer/package.json': JSON.stringify({ scripts: { test: "files=$(find src | node x.mjs) && tsx --import ./src/test/hooks.mjs --test --test-concurrency=1 $files" } }),
    'apps/viewer/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./src/*'] } } }),
    'apps/viewer/test-durations.json': JSON.stringify({ shards: 16, seconds: { 'src/a.test.ts': 100, 'src/b.test.ts': 400 } }),
    'apps/viewer/src/test/hooks.mjs': '',
    'apps/viewer/src/a.test.ts': "import '@/lib/util.js';",
    'apps/viewer/src/b.test.ts': "import './lib/mid.js';",
    'apps/viewer/src/lib/mid.ts': "export * from './util.js';",
    'apps/viewer/src/lib/util.ts': 'export const x = 1;',
    'packages/parser/package.json': JSON.stringify({ name: '@ifc-lite/parser' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
  });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
  write(root, change);
  git(root, 'add', '-A');
  git(root, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'change');
  return root;
}

function cli(root, mode, extra = {}) {
  const out = join(root, '.out');
  const ghOut = join(root, '.gh-output');
  const summary = join(root, '.gh-summary');
  writeFileSync(ghOut, '');
  writeFileSync(summary, '');
  const script = `import { run } from ${JSON.stringify(CLI)}; process.exitCode = run(process.argv.slice(1), process.env, ${JSON.stringify(root)});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', '--select', '--out', out], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH, GITHUB_OUTPUT: ghOut, GITHUB_STEP_SUMMARY: summary, GITHUB_EVENT_NAME: 'pull_request',
      LANE: 'fast', NOOP: 'false', HEAD_REF: 'feat/x', CI_PR_VIEWER_SELECT: mode, ...extra,
    },
  });
  const outputs = Object.fromEntries(readFileSync(ghOut, 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
  const selection = existsSync(join(out, 'selection.json')) ? JSON.parse(readFileSync(join(out, 'selection.json'), 'utf8')) : null;
  const files = existsSync(join(out, 'files.txt')) ? readFileSync(join(out, 'files.txt'), 'utf8').split('\n').filter(Boolean) : null;
  return { code: r.status, stderr: r.stderr, outputs, selection, files, summary: readFileSync(summary, 'utf8') };
}

test('CLI off: no selection, no artifact, nothing to run', () => {
  const r = cli(fixtureRepo({ 'apps/viewer/src/lib/util.ts': 'export const x = 2;' }), 'off');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.outputs, { run: 'false', count: '0', artifact: 'false' });
  assert.equal(r.selection, null);
});

test('CLI shadow: records the selection and runs nothing', () => {
  const r = cli(fixtureRepo({ 'apps/viewer/src/lib/util.ts': 'export const x = 2;' }), 'shadow', { PR_NUMBER: '42' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.outputs, { run: 'false', count: '1', artifact: 'true' });
  assert.deepEqual(r.selection.distance, { 'apps/viewer/src/a.test.ts': 1, 'apps/viewer/src/b.test.ts': 2 });
  assert.deepEqual(r.selection.selected, ['apps/viewer/src/a.test.ts', 'apps/viewer/src/b.test.ts']);
  assert.equal(r.selection.pr, '42');
  assert.match(r.summary, /Shadow mode: no test ran/); // @source-text-assertion-ok subject is the CLI's written step summary
});

test('CLI on: runs the sample, paths relative to apps/viewer, and states what the budget left out', () => {
  const r = cli(fixtureRepo({ 'apps/viewer/src/lib/util.ts': 'export const x = 2;' }), 'on');
  assert.equal(r.code, 0, r.stderr);
  // a.test.ts is nearer and kept; b.test.ts measures 400 s, and 100 + 400 exceeds the 420 s budget.
  assert.deepEqual(r.outputs, { run: 'true', count: '1', artifact: 'true' });
  assert.deepEqual(r.files, ['src/a.test.ts']);
  assert.deepEqual(r.selection.leftOut, ['apps/viewer/src/b.test.ts']);
  assert.match(r.summary, /1 reachable test file\(s\) were left out by the budget/); // @source-text-assertion-ok subject is the CLI's written step summary
});

test('CLI on, FAIL CLOSED: an unmappable-only change runs nothing and says why', () => {
  const r = cli(fixtureRepo({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n# bump\n', 'rust/core/src/lib.rs': 'fn main() {}' }), 'on');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.outputs, { run: 'false', count: '0', artifact: 'true' });
  assert.deepEqual(r.files, []);
  assert.match(r.summary, /2 changed file\(s\) could not be mapped to viewer tests and selected nothing/); // @source-text-assertion-ok subject is the CLI's written step summary
  assert.match(r.summary, /`rust\/core\/src\/lib\.rs`: WASM or Rust input/); // @source-text-assertion-ok subject is the CLI's written step summary
});

test('CLI on: a mixed change runs only what the mappable part reaches', () => {
  const r = cli(fixtureRepo({ 'apps/viewer/src/a.test.ts': "import '@/lib/util.js';\n// edited", 'pnpm-lock.yaml': '# bump\n' }), 'on');
  assert.deepEqual(r.files, ['src/a.test.ts']);
  assert.deepEqual(r.selection.selected, ['apps/viewer/src/a.test.ts']);
  assert.equal(r.selection.changes.find((c) => c.path === 'pnpm-lock.yaml').class, 'unmapped');
});

test('CLI: an unreadable diff is an error, not an empty green selection', () => {
  const root = fixtureRepo({ 'apps/viewer/src/lib/util.ts': 'export const x = 2;' });
  rmSync(join(root, '.git'), { recursive: true, force: true });
  const r = cli(root, 'on');
  assert.notEqual(r.code, 0);
  assert.equal(r.outputs.run, undefined, 'no run output, so the test steps stay skipped');
});

test('CLI --run refuses an empty file list rather than letting tsx glob everything', () => {
  const dir = mkdtempSync(join(TMP, 'run-'));
  writeFileSync(join(dir, 'files.txt'), '');
  const r = spawnSync(process.execPath, [CLI, '--run', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /files\.txt is empty/); // @source-text-assertion-ok subject is the CLI's error output; the exit code is asserted above
});

// ---------------------------------------------------------------- the wiring

const WORKFLOW_TEXT = readFileSync(join(REPO_ROOT, '.github/workflows/test.yml'), 'utf8');
const JOBS = parse(WORKFLOW_TEXT).jobs;
const JOB = JOBS['viewer-tests-selected'];

test('WIRING: the job runs only on a switched-on, fast-lane, non-batch, non-replay PR', () => {
  const cond = JOB.if;
  for (const clause of [
    "github.event_name == 'pull_request'",
    "(vars.CI_PR_VIEWER_SELECT == 'shadow' || vars.CI_PR_VIEWER_SELECT == 'on')",
    "needs.changes.outputs.lane == 'fast'",
    "needs.changes.outputs.batch != 'true'",
    "needs.changes.outputs.noop != 'true'",
  ]) assert.ok(cond.includes(clause), clause); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  assert.ok(!/\|\|\s*vars\.CI_PR_VIEWER_SELECT\s*!=/.test(cond), 'no negative switch test that an unset variable would satisfy');
});

test('WIRING: advisory by design, outside the aggregate, and the coverage gate knows why', () => {
  const agg = readAggregate(WORKFLOW_TEXT);
  assert.ok(!agg.needs.includes('viewer-tests-selected')); // @source-text-assertion-ok subject is the parsed aggregate needs list
  assert.ok('viewer-tests-selected' in UNJUDGED_BY_DESIGN);
  assert.deepEqual(unwatched(WORKFLOW_TEXT, agg), []);
});

test('WIRING: the select step feeds the switch inputs, and every heavy step waits on `run`', () => {
  const steps = JOB.steps;
  const select = steps.findIndex((s) => s.id === 'select');
  assert.ok(select >= 0);
  // The literal workflow expressions this test pins, not template strings.
  /* eslint-disable no-template-curly-in-string */
  assert.equal(steps[select].env.CI_PR_VIEWER_SELECT, '${{ vars.CI_PR_VIEWER_SELECT }}');
  assert.equal(steps[select].env.LANE, '${{ needs.changes.outputs.lane }}');
  assert.equal(steps[select].env.NOOP, '${{ needs.changes.outputs.noop }}');
  assert.equal(steps[select].env.HEAD_REF, '${{ github.head_ref }}');
  /* eslint-enable no-template-curly-in-string */
  const upload = steps.find((s) => s.name === 'Upload the selection');
  assert.equal(upload.if, "steps.select.outputs.artifact == 'true'");
  for (const s of steps.slice(select + 1)) {
    if (s === upload) continue;
    assert.ok(String(s.if ?? '').startsWith("steps.select.outputs.run == 'true'"), `${s.name ?? s.uses ?? s.run} must wait on run`); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
  }
  assert.ok(steps.at(-1).run.includes('ci-viewer-select.mjs --run')); // @source-text-assertion-ok workflow wiring pin: the subject IS the YAML; there is no runtime to drive instead
});
