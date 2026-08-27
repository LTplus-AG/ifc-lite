/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof that `scripts/check-ci-path-coverage.mjs` cannot pass
 * vacuously.
 *
 * "No gate input is outside its trigger" is equally true of a repo with no
 * holes and of a check that found no gates, parsed no filters, or derived no
 * inputs. Every one of those must be a NAMED failure, and each is exercised
 * here against a synthetic tree so the assertions do not move when the real
 * workflows do.
 *
 * The firing half is checked by REINTRODUCING a hole -- the synthetic twin of
 * the four real ones (#3312) -- and asserting the report names the specific
 * file, not just that the exit code moved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  cpSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  globToRegExp,
  matchesAny,
  parseFilterBlock,
  splitJobs,
  gatingFilters,
  parseWorkflowPrPaths,
  deriveInputs,
  dropSubsumed,
  gitignoreToGlobs,
} from './lib/ci-path-coverage.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = join(HERE, 'check-ci-path-coverage.mjs');
const REPO = join(HERE, '..');

/** Run the check against `root`; returns `{ status, out }` with stdout+stderr merged. */
function run(root) {
  try {
    const out = execFileSync(process.execPath, [CHECK, '--root', root], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, out };
  } catch (err) {
    return { status: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const WORKFLOW = (filters, steps) => `name: Test

on:
  pull_request:
    branches: [main]

jobs:
  changes:
    name: Detect changes
    runs-on: ubuntu-latest
    steps:
      - uses: dorny/paths-filter@v4
        id: filter
        with:
          filters: |
${filters}

  gated:
    name: Gated
    needs: changes
    if: needs.changes.outputs.frontend == 'true'
    runs-on: ubuntu-latest
    steps:
${steps}
`;

const DEFAULT_FILTERS = [
  '            frontend:',
  "              - 'src/**'",
  "              - 'scripts/**'",
  // The check genuinely reads the workflow directory, so a fixture that does
  // not carry it is not a clean tree.
  "              - '.github/workflows/**'",
].join('\n');

const DEFAULT_STEPS = [
  '      - run: node scripts/gate.mjs',
  '      - run: node scripts/check-ci-path-coverage.mjs',
].join('\n');

/**
 * A minimal repo where the check is GREEN, so every later case can change one
 * thing and attribute the failure to it.
 */
function makeTree(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ci-path-coverage-'));
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'src/covered'), { recursive: true });

  writeFileSync(
    join(root, '.github/workflows/test.yml'),
    overrides.workflow ?? WORKFLOW(overrides.filters ?? DEFAULT_FILTERS, overrides.steps ?? DEFAULT_STEPS),
  );
  writeFileSync(join(root, 'src/covered/thing.ts'), 'export const x = 1;\n');
  if (overrides.gate !== null) {
    writeFileSync(join(root, 'scripts/gate.mjs'), overrides.gate ?? "const dir = 'src/covered';\n");
  }
  // The check reads its own source and its own lib out of the tree it is
  // pointed at, so the fixture must carry both for self-coverage to resolve.
  writeFileSync(join(root, 'scripts/check-ci-path-coverage.mjs'), readFileSync(CHECK, 'utf8'));
  writeFileSync(
    join(root, 'scripts/lib/ci-path-coverage.mjs'),
    readFileSync(join(HERE, 'lib/ci-path-coverage.mjs'), 'utf8'),
  );
  writeFileSync(
    join(root, 'scripts/ci-path-coverage-allowlist.txt'),
    overrides.allowlist ?? '# none\n',
  );
  return root;
}

function withTree(overrides, fn) {
  const root = makeTree(overrides);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Baseline: the synthetic tree is clean, so every failure below is attributable.
// ---------------------------------------------------------------------------

test('a tree with no holes passes', () => {
  withTree({}, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 0, out);
    assert.match(out, /all inside their own trigger/);
  });
});

// ---------------------------------------------------------------------------
// It FIRES: the synthetic twin of the four real holes.
// ---------------------------------------------------------------------------

test('names the specific file when a gate input is outside its trigger', () => {
  withTree(
    { gate: "const scan = 'src';\n" }, // walks all of src/, filter only carries src/**... so add an uncovered sibling
    (root) => {
      mkdirSync(join(root, 'unfiltered'), { recursive: true });
      writeFileSync(join(root, 'unfiltered/input.json'), '{}\n');
      writeFileSync(join(root, 'scripts/gate.mjs'), "const input = 'unfiltered/input.json';\n");
      const { status, out } = run(root);
      assert.equal(status, 1);
      assert.match(out, /unfiltered\/input\.json/);
      assert.match(out, /cannot trigger it/);
    },
  );
});

test('reports the shallowest uncovered subtree, not every file under it', () => {
  withTree({ gate: "const scan = 'src';\n" }, (root) => {
    mkdirSync(join(root, 'src2/deep'), { recursive: true });
    for (const n of ['a', 'b', 'c']) writeFileSync(join(root, `src2/deep/${n}.ts`), '\n');
    writeFileSync(join(root, 'scripts/gate.mjs'), "const scan = 'src2';\n");
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /- src2\b/);
    assert.doesNotMatch(out, /src2\/deep\/a\.ts/);
  });
});

// ---------------------------------------------------------------------------
// It FAILS CLOSED. Each of these would otherwise report "no holes found".
// ---------------------------------------------------------------------------

test('an empty workflow directory fails rather than reporting clean', () => {
  withTree({}, (root) => {
    rmSync(join(root, '.github/workflows/test.yml'));
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /test\.yml is missing/);
  });
});

test('an unparseable filter block fails with a named reason', () => {
  withTree({ workflow: 'name: Test\non:\n  pull_request:\n\njobs:\n  a:\n    runs-on: x\n' }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /cannot parse the path filters/);
  });
});

test('a filter block that parses to zero filters fails', () => {
  withTree({ filters: '            # nothing here' }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /zero filters|cannot parse the path filters/);
  });
});

test('a workflow that runs no gate scripts fails rather than passing', () => {
  withTree({ steps: '      - run: echo hello' }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /no `node scripts\/\*\.mjs` gates found/);
  });
});

test('a workflow referencing a gate script that does not exist fails', () => {
  withTree({ gate: null }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /which does not exist in the tree/);
  });
});

test('a job gating on a filter the block does not define fails', () => {
  withTree({ filters: "            backend:\n              - 'src/**'" }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /unknown filter/);
  });
});

test('a missing allowlist fails', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'scripts/ci-path-coverage-allowlist.txt'));
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /allowlist\.txt is missing/);
  });
});

test('an allowlist entry with no written reason is refused', () => {
  withTree({ allowlist: 'scripts/gate.mjs src/covered\n' }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /Every exemption needs a written reason/);
  });
});

test('an allowlist entry that no longer matches anything fails', () => {
  withTree({ allowlist: 'scripts/gate.mjs gone/** # stale\n' }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /which is now covered \(or gone\)/);
  });
});

test("the check's own config being outside its own trigger is itself a failure", () => {
  // The very defect the check detects, aimed at the check: drop `scripts/**`
  // from the filter, and the check must name its own files.
  withTree({ filters: "            frontend:\n              - 'src/**'" }, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 1);
    assert.match(out, /scripts\/ci-path-coverage-allowlist\.txt is this check.s own config/);
  });
});

// ---------------------------------------------------------------------------
// Unit level: the parsing and glob semantics the whole thing rests on.
// ---------------------------------------------------------------------------

test('globToRegExp follows picomatch separator rules', () => {
  assert.ok(globToRegExp('rust/**').test('rust/core/src/lib.rs'));
  assert.ok(globToRegExp('rust/**').test('rust'), '`a/**` must cover the bare directory');
  assert.ok(globToRegExp('packages/*/README.md').test('packages/parser/README.md'));
  assert.ok(
    !globToRegExp('packages/*/README.md').test('packages/parser/src/README.md'),
    '`*` must not cross a separator',
  );
  assert.ok(globToRegExp('tsconfig*.json').test('tsconfig.build.json'));
  assert.ok(!globToRegExp('tsconfig*.json').test('apps/tsconfig.json'));
  assert.ok(!globToRegExp('.github/workflows/test.yml').test('.github/workflows/testXyml'));
});

test('globToRegExp refuses syntax it cannot translate rather than matching loosely', () => {
  assert.throws(() => globToRegExp('src/{a,b}/**'), /unsupported glob syntax/);
  assert.throws(() => globToRegExp(''), /empty glob/);
});

test('parseFilterBlock rejects a line it does not understand', () => {
  assert.throws(
    () => parseFilterBlock('        filters: |\n          rust:\n            - unquoted/glob\n'),
    /unrecognised line/,
  );
  assert.throws(() => parseFilterBlock('nothing here'), /no `filters: \|` block/);
  assert.throws(
    () => parseFilterBlock('        filters: |\n          rust:\n          frontend:\n'),
    /has no globs/,
  );
});

test('splitJobs drops comment lines so a mention is not read as an invocation', () => {
  const jobs = splitJobs(
    'jobs:\n  a:\n    runs-on: x\n    steps:\n      # node scripts/mentioned.mjs\n      - run: node scripts/real.mjs\n',
  );
  assert.equal(jobs.length, 1);
  assert.ok(jobs[0].text.includes('scripts/real.mjs'));
  assert.ok(!jobs[0].text.includes('scripts/mentioned.mjs'));
});

test('gatingFilters reads positive terms only', () => {
  assert.deepEqual(gatingFilters("    if: needs.changes.outputs.frontend == 'true'"), ['frontend']);
  assert.deepEqual(
    gatingFilters(
      "    if: needs.changes.outputs.docs == 'true' && needs.changes.outputs.rust != 'true'",
    ),
    ['docs'],
    'a `!=` term narrows the job and cannot widen coverage',
  );
  assert.equal(gatingFilters('    if: always()'), null);
  assert.equal(gatingFilters('    runs-on: x'), null);
});

test('parseWorkflowPrPaths distinguishes no-paths from a paths list', () => {
  assert.deepEqual(
    parseWorkflowPrPaths("on:\n  pull_request:\n    branches: [main]\n    paths:\n      - 'a/**'\n"),
    { triggersOnPr: true, paths: ['a/**'] },
  );
  assert.deepEqual(parseWorkflowPrPaths('on:\n  pull_request:\n    branches: [main]\n'), {
    triggersOnPr: true,
    paths: null,
  });
  assert.equal(parseWorkflowPrPaths('on:\n  schedule:\n    - cron: "0 0 * * *"\n').triggersOnPr, false);
});

test('deriveInputs keeps only literals that resolve, and never escapes the repo', () => {
  const exists = (p) => ['apps', 'apps/landing/app.jsx', 'tests/benchmark/baseline.json'].includes(p);
  const src = `
    const SEARCH_DIRS = ['apps'];
    const file = 'apps/landing/app.jsx';
    const base = join(ROOT, 'tests', 'benchmark', 'baseline.json');
    const escape = join(ROOT, '..', '..', 'secrets');
    const prose = 'this is not a path';
    const templated = \`\${ROOT}/nope\`;
  `;
  const got = deriveInputs(src, exists);
  // `apps/landing/app.jsx` is subsumed by the `apps` walk and collapses into
  // it -- see dropSubsumed. Coverage of that exact file is held instead by
  // REQUIRED_COVERAGE in the check, which is why the by-name floor exists.
  assert.deepEqual(got, ['apps', 'tests/benchmark/baseline.json']);
  assert.ok(!got.some((p) => p.includes('secrets')), 'a `..` segment must never survive');
  assert.ok(!got.includes('this is not a path'));
});

test('dropSubsumed keeps the parent, which is the safe direction', () => {
  // Preferring the most specific literal would have dropped `apps` in favour of
  // `apps/viewer`, and `apps/landing` -- the real defect -- would never surface.
  assert.deepEqual(dropSubsumed(['apps', 'apps/viewer', 'packages']), ['apps', 'packages']);
});

test('matchesAny is false for a sibling that merely shares a prefix', () => {
  assert.ok(!matchesAny('apps/landing/app.jsx', ['apps/viewer/**', 'apps/viewer-embed/**']));
  assert.ok(matchesAny('apps/viewer/src/main.ts', ['apps/viewer/**']));
});

// ---------------------------------------------------------------------------
// The real tree, and the four real holes reintroduced in it.
// ---------------------------------------------------------------------------

test('the real repository has no gate input outside its trigger', () => {
  const { status, out } = run(REPO);
  assert.equal(status, 0, out);
});

/**
 * A mirror of the real repo whose `.github/` is a real copy and whose other
 * top-level entries are symlinks, so a mutation of `test.yml` costs a few
 * kilobytes instead of a full tree copy. The check resolves symlinked
 * directories through `statSync`, so the walk sees the real files.
 */
function mirrorRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ci-path-coverage-mirror-'));
  for (const entry of readdirSync(REPO)) {
    if (entry === '.git' || entry === 'node_modules') continue;
    // `.github` is copied because the hole tests mutate test.yml. `tests` is
    // copied because the fixture-cache test plants a fetched `.ifc` under
    // `tests/models`, and writing through a symlink would land it in the real
    // tree. Both are small; everything else stays a symlink.
    if (entry === '.github' || entry === 'tests') {
      cpSync(join(REPO, entry), join(root, entry), { recursive: true });
    } else symlinkSync(join(REPO, entry), join(root, entry));
  }
  return root;
}

/** Delete one `- '<glob>'` line from the mirror's filter block. */
function dropFilterEntry(root, glob) {
  const file = join(root, '.github/workflows/test.yml');
  const before = readFileSync(file, 'utf8');
  const after = before
    .split('\n')
    .filter((l) => l.trim() !== `- '${glob}'`)
    .join('\n');
  assert.notEqual(after, before, `filter entry '${glob}' was not found to remove`);
  writeFileSync(file, after);
}

// The four holes this check was written for. Each asserts the report names the
// SPECIFIC file, which is what a count floor would not have caught.
for (const [glob, expected] of [
  ['.github/workflows/**', /\.github\/workflows\/release\.yml cannot trigger scripts\/check-swallowed-push\.mjs/],
  ['tests/integration.test.ts', /tests\/integration\.test\.ts cannot trigger scripts\/check-test-wiring\.mjs/],
  [
    'tests/benchmark/baseline.json',
    /tests\/benchmark\/baseline\.json cannot trigger scripts\/docs\/generate-docs-sections\.mjs/,
  ],
  [
    'apps/landing/**',
    /apps\/landing\/app\.jsx cannot trigger scripts\/docs\/generate-docs-sections\.mjs/,
  ],
]) {
  test(`removing '${glob}' from the filters reopens a real hole and is named`, () => {
    const root = mirrorRepo();
    try {
      assert.equal(run(root).status, 0, 'the mirror must be green before the mutation');
      dropFilterEntry(root, glob);
      const { status, out } = run(root);
      assert.equal(status, 1, out);
      assert.match(out, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}


// ---------------------------------------------------------------------------
// The verdict is a function of the COMMIT, not of the working tree.
// ---------------------------------------------------------------------------

test('gitignoreToGlobs: a bare name is ignored at every depth, and so is its subtree', () => {
  const g = gitignoreToGlobs('node_modules\n');
  for (const p of ['node_modules', 'node_modules/x/a.js', 'packages/cli/node_modules/y.js']) {
    assert.ok(matchesAny(p, g), `${p} must be ignored`);
  }
  assert.equal(matchesAny('packages/cli/src/node_modules_helper.ts', g), false);
});

test('gitignoreToGlobs: a slash anywhere but the end anchors the pattern to the root', () => {
  const g = gitignoreToGlobs('tests/models/local\n');
  assert.ok(matchesAny('tests/models/local', g));
  assert.ok(matchesAny('tests/models/local/a.ifc', g));
  // Anchored: the same name deeper in the tree is NOT covered.
  assert.equal(matchesAny('packages/tests/models/local', g), false);
});

test('gitignoreToGlobs: `a/**/b` covers ZERO intervening directories, as git does', () => {
  // The case that let the fetched corpus stay visible: `tests/models/AB22.ifc`
  // sits directly under the directory, with no directory between the `**` and
  // the file, and a `**` rendered as `.*` needs the separators on both sides.
  const g = gitignoreToGlobs('tests/models/**/*.ifc\n');
  assert.ok(matchesAny('tests/models/AB22.ifc', g), 'zero-directory case');
  assert.ok(matchesAny('tests/models/ara3d/duplex.ifc', g), 'one-directory case');
  assert.equal(matchesAny('tests/models/manifest.json', g), false);
});

test('gitignoreToGlobs: a trailing slash still names the directory itself', () => {
  const g = gitignoreToGlobs('dist/\n');
  assert.ok(matchesAny('packages/cli/dist', g));
  assert.ok(matchesAny('packages/cli/dist/loader.js', g));
});

test('gitignoreToGlobs: a negation is REFUSED rather than silently dropped', () => {
  // A dropped `!` line means the walk wanders back into a tree the union said
  // was excluded -- the failure this whole exclusion exists to prevent.
  assert.throws(() => gitignoreToGlobs('dist/\n!dist/keep.js\n'), /negation/);
});

test('the real ignore file is translatable -- the exclusion cannot go silently empty', () => {
  const globs = gitignoreToGlobs(readFileSync(join(REPO, '.gitignore'), 'utf8'));
  assert.ok(globs.length > 0);
  // Spot-check the three trees whose presence in CI, and absence on a clean
  // checkout, made this check disagree with itself on one commit.
  assert.ok(matchesAny('node_modules', globs));
  assert.ok(matchesAny('packages/cli/dist/loader.js', globs));
  assert.ok(matchesAny('tests/models/ara3d/duplex.ifc', globs));
  // And the committed inputs under the same roots must SURVIVE it.
  assert.equal(matchesAny('tests/models/manifest.json', globs), false);
  assert.equal(matchesAny('packages/data/src/step-serializers.ts', globs), false);
});

test('an installed node_modules does not change the verdict -- the live #3314 CI failure', () => {
  // Ran green on a clean checkout and red in CI on the IDENTICAL commit: the
  // walk's skip set filtered a walk's CHILDREN but never the ROOT it was asked
  // about, so `node_modules` as a derived input enumerated the whole install
  // and reported it, once per gate, as a path outside its own trigger.
  const root = mirrorRepo();
  const before = run(root);
  assert.equal(before.status, 0, before.out);

  mkdirSync(join(root, 'node_modules/some-package'), { recursive: true });
  writeFileSync(join(root, 'node_modules/some-package/index.js'), 'export default 1;\n');
  const after = run(root);

  assert.equal(after.status, before.status, after.out);
  assert.equal(
    after.out,
    before.out,
    'the report must be byte-identical: an install is not a change to the commit',
  );
  rmSync(root, { recursive: true, force: true });
});

test('a warmed fixture cache does not change the verdict either', () => {
  // `tests/models` holds two COMMITTED files and, after the fixture step runs,
  // several hundred fetched `.ifc` files that git ignores. The walk is asked
  // about the directory (which is a real input -- `manifest.json` lives there),
  // so the exclusion has to hold on the walk's CHILDREN, not only on the node
  // it was asked about.
  const root = mirrorRepo();
  const before = run(root);
  assert.equal(before.status, 0, before.out);

  mkdirSync(join(root, 'tests/models/ara3d'), { recursive: true });
  writeFileSync(join(root, 'tests/models/ara3d/duplex.ifc'), 'ISO-10303-21;\n');
  writeFileSync(join(root, 'tests/models/AB22.ifc'), 'ISO-10303-21;\n');
  const after = run(root);

  assert.equal(after.status, before.status, after.out);
  assert.equal(after.out, before.out, 'a fetched corpus is not a change to the commit');
  rmSync(root, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// The trigger parser fails closed on shapes it cannot read.
// ---------------------------------------------------------------------------

const PR_BLOCK = "on:\n  pull_request:\n    paths:\n      - 'rust/**'\n";

test('parseWorkflowPrPaths still reads the block form it was written for', () => {
  // The refusals below must not have been bought by refusing everything.
  assert.deepEqual(parseWorkflowPrPaths(PR_BLOCK), { triggersOnPr: true, paths: ['rust/**'] });
  assert.deepEqual(parseWorkflowPrPaths("on:\n  pull_request:\n    paths-ignore:\n      - 'docs/**'\n"), {
    triggersOnPr: true,
    paths: null,
  });
  // No `paths:` at all is genuinely "every path", and must stay null.
  assert.deepEqual(parseWorkflowPrPaths('on:\n  pull_request:\n'), {
    triggersOnPr: true,
    paths: null,
  });
});

test('an INLINE paths list is refused, not read as "triggers on everything"', () => {
  // The dangerous direction: the block matcher required an empty tail after
  // the colon, so `paths: ['rust/**']` fell through and left paths at null --
  // the widest coverage claim there is, asserted about a workflow that is in
  // fact narrowly filtered. Every gate input under it would look reachable.
  assert.throws(
    () => parseWorkflowPrPaths("on:\n  pull_request:\n    paths: ['rust/**']\n"),
    /written inline/,
  );
  assert.throws(
    () => parseWorkflowPrPaths("on:\n  pull_request:\n    paths-ignore: ['docs/**']\n"),
    /written inline/,
  );
});

test('an unquoted list entry is refused, not silently dropped', () => {
  // Errs the safe way -- a short trigger list over-reports violations -- but a
  // finding derived from a truncated list is indistinguishable from a real one.
  assert.throws(
    () => parseWorkflowPrPaths('on:\n  pull_request:\n    paths:\n      - rust/**\n'),
    /unparseable entry/,
  );
});

test('the checker NAMES the workflow it could not parse, rather than throwing a stack', () => {
  const root = mirrorRepo();
  writeFileSync(
    join(root, '.github/workflows/zz-inline-paths.yml'),
    "name: Inline\non:\n  pull_request:\n    paths: ['rust/**']\njobs:\n  a:\n    name: A\n" +
      '    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/check-module-size.mjs\n',
  );
  const r = run(root);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /zz-inline-paths\.yml/, 'the report must name the workflow');
  assert.match(r.out, /written inline/);
  assert.doesNotMatch(r.out, /at parseWorkflowPrPaths/, 'not an uncaught stack trace');
  rmSync(root, { recursive: true, force: true });
});
