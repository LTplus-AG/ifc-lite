/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Executable proof that check-test-wiring.mjs cannot pass vacuously.
 *
 * A wiring gate has the same failure mode as the thing it guards: if its
 * search root is wrong, its discovery empty, or its notion of "wired"
 * satisfiable by something that never executes, it prints OK forever and
 * nobody learns anything. Every fixture below drives the UNMODIFIED checker
 * through `--root` against a synthetic tree, never real repo state.
 *
 * The first fixture is not synthetic in shape: it reconstructs #3062's
 * pre-wiring state — a gate script and its test committed with no workflow
 * step and no package.json entry — which the checker before this change saw
 * as nothing at all, because `scripts/` was outside its scan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER = join(dirname(fileURLToPath(import.meta.url)), 'check-test-wiring.mjs');

/** The catch-all step #3038 added: a bare glob, one directory level only. */
const GLOB_CATCH_ALL = '      - name: Run every scripts/ test file (glob catch-all)\n' +
  '        run: node --test scripts/*.test.mjs scripts/lib/*.test.mjs\n';

function write(root, rel, contents) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
  return abs;
}

/**
 * A minimally well-formed tree: one workspace package that IS wired, one
 * gate script that IS wired, one scripts/ test the catch-all reaches. Every
 * fixture starts from this and breaks exactly one thing, so a red is
 * attributable to that one thing.
 */
function baseTree(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-test-wiring-'));
  const scripts = { 'check:wired': 'node scripts/check-wired.mjs', ...overrides.rootScripts };
  write(root, 'package.json', JSON.stringify({ name: 'root', scripts }, null, 2));
  write(root, 'packages/alpha/package.json', JSON.stringify({ name: 'alpha', scripts: { test: 'vitest run' } }));
  write(root, 'packages/alpha/src/alpha.test.ts', 'test');
  write(root, 'scripts/check-wired.mjs', '// a gate CI runs\n');
  write(root, 'scripts/check-wired.test.mjs', '// its harness\n');
  write(
    root,
    '.github/workflows/test.yml',
    'jobs:\n  node-tests:\n    steps:\n' +
      '      - name: Check wired\n        run: node scripts/check-wired.mjs\n' +
      GLOB_CATCH_ALL +
      (overrides.extraSteps ?? ''),
  );
  return root;
}

function run(root) {
  const r = spawnSync(process.execPath, [CHECKER, '--root', root], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function withTree(overrides, fn) {
  const root = baseTree(overrides);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------- *
 * The baseline: the fixture the others are perturbations of is GREEN. *
 * ---------------------------------------------------------------- */

test('a fully wired tree passes', () => {
  withTree({}, (root) => {
    const { status, out } = run(root);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-wiring: OK/);
  });
});

/* ---------------------------------------------------------------- *
 * #3062, reconstructed.                                              *
 * ---------------------------------------------------------------- */

test('#3062 pre-wiring state: a gate script and its test with no workflow step and no package.json entry', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-loader-hook-specifier-match.mjs', '// the gate #3062 shipped\n');
    write(root, 'scripts/check-loader-hook-specifier-match.test.mjs', '// the harness #3062 shipped\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /Gate scripts nothing in CI runs/);
    assert.match(out, /scripts\/check-loader-hook-specifier-match\.mjs/);
    assert.match(out, /no workflow step and no package\.json script runs it/);
  });
});

test('#3062: the TEST half is separately green — #3038\'s glob reaches it, and that must not excuse the script', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-loader-hook-specifier-match.mjs', '// gate\n');
    write(root, 'scripts/check-loader-hook-specifier-match.test.mjs', '// harness\n');
    const { out } = run(root);
    // The test file is reached by the catch-all, so it is NOT reported...
    assert.doesNotMatch(out, /scripts\/ test files no workflow runs/);
    // ...and the script is reported anyway. A gate whose test runs but whose
    // script never executes is still the #3062 failure.
    assert.match(out, /Gate scripts nothing in CI runs/);
  });
});

test('#3062, wired: adding the workflow step turns it green', () => {
  withTree({
    extraSteps: '      - name: Check loader hook specifier match\n' +
      '        run: node scripts/check-loader-hook-specifier-match.mjs\n',
  }, (root) => {
    write(root, 'scripts/check-loader-hook-specifier-match.mjs', '// gate\n');
    write(root, 'scripts/check-loader-hook-specifier-match.test.mjs', '// harness\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

/* ---------------------------------------------------------------- *
 * What counts as wired, in both directions.                          *
 * ---------------------------------------------------------------- */

test('a package.json entry NOBODY invokes is not wiring', () => {
  withTree({ rootScripts: { 'check:orphan': 'node scripts/check-orphan.mjs' } }, (root) => {
    write(root, 'scripts/check-orphan.mjs', '// gate\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-orphan\.mjs.*package\.json "check:orphan" runs it, but no workflow runs that script/);
  });
});

test('a package.json entry a workflow DOES invoke is wiring, transitively through another script', () => {
  withTree({
    rootScripts: { lint: 'node scripts/check-orphan.mjs', ci: 'pnpm lint' },
    extraSteps: '      - name: Lint\n        run: pnpm ci\n',
  }, (root) => {
    write(root, 'scripts/check-orphan.mjs', '// gate\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a WORKSPACE package script reached by a turbo task is wiring (check-tla-chunk-await\'s real shape)', () => {
  withTree({ extraSteps: '      - name: Build viewer\n        run: pnpm turbo build --filter=@ifc-lite/viewer\n' }, (root) => {
    write(root, 'scripts/check-tla.mjs', '// gate\n');
    write(
      root,
      'apps/viewer/package.json',
      JSON.stringify({ name: 'viewer', scripts: { build: 'vite build && node ../../scripts/check-tla.mjs' } }),
    );
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a workspace script whose task CI never runs is NOT wiring', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-tla.mjs', '// gate\n');
    write(
      root,
      'apps/viewer/package.json',
      JSON.stringify({ name: 'viewer', scripts: { 'check:local': 'node ../../scripts/check-tla.mjs' } }),
    );
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-tla\.mjs/);
  });
});

test('a gate named only inside a workflow COMMENT is not wired', () => {
  withTree({
    extraSteps: '      # run: node scripts/check-commented.mjs   # disabled for now\n',
  }, (root) => {
    write(root, 'scripts/check-commented.mjs', '// gate\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-commented\.mjs/);
  });
});

test('a gate merely NAMED in a workflow (a paths: filter) is not wired — the line must spawn node', () => {
  withTree({
    extraSteps: '    paths:\n      - scripts/check-mentioned.mjs\n',
  }, (root) => {
    write(root, 'scripts/check-mentioned.mjs', '// gate\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-mentioned\.mjs/);
  });
});

test('audit-*.mjs is a reporter by naming convention, not a gate, and is not demanded', () => {
  withTree({}, (root) => {
    write(root, 'scripts/audit-something.mjs', '// reports, does not gate\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

/* ---------------------------------------------------------------- *
 * The declared exception.                                            *
 * ---------------------------------------------------------------- */

test('@unwired-by-design with a reason passes, and the exception is PRINTED rather than hidden', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-local-only.mjs', '/**\n * @unwired-by-design a local pre-push tool, green on every CI checkout.\n */\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
    assert.match(out, /not a CI gate by declaration: scripts\/check-local-only\.mjs — a local pre-push tool/);
  });
});

test('@unwired-by-design with no real reason is rejected', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-local-only.mjs', '/** @unwired-by-design nope */\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /needs a reason of at least/);
  });
});

/* ---------------------------------------------------------------- *
 * Evasions of 2a itself, found by adversarial review of this PR.     *
 * ---------------------------------------------------------------- */

test('a gate in a scripts/ SUBDIRECTORY is audited — 2a walks the tree 2b already walks', () => {
  withTree({}, (root) => {
    write(root, 'scripts/ci/check-evader.mjs', '// a gate nothing runs, one directory down\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /Gate scripts nothing in CI runs/);
    assert.match(out, /scripts\/ci\/check-evader\.mjs/);
  });
});

test('the two halves agree on the tree: the SAME subdirectory hides neither a gate nor its test', () => {
  withTree({}, (root) => {
    write(root, 'scripts/ci/check-evader.mjs', '// gate\n');
    write(root, 'scripts/ci/check-evader.test.mjs', '// its harness\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    // 2b already saw the test. 2a must see the script in the very same place,
    // or the failure text ("move the file into one of those directories")
    // routes authors straight into 2a's blind spot.
    assert.match(out, /scripts\/ci\/check-evader\.mjs/);
    assert.match(out, /scripts\/ci\/check-evader\.test\.mjs/);
  });
});

test('a subdirectory gate a WIRED script imports is not demanded — a file a running gate runs, runs', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-wired.mjs', "import './lib/check-shared.mjs';\n");
    write(root, 'scripts/lib/check-shared.mjs', '// a module, not a gate\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('transitive reach is transitive: a module reached only through another module still counts', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-wired.mjs', "import './lib/check-shared.mjs';\n");
    write(root, 'scripts/lib/check-shared.mjs', "import './check-deeper.mjs';\n");
    write(root, 'scripts/lib/check-deeper.mjs', '// two hops from the workflow\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('reach follows CODE only — naming a file in a comment does not run it', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-wired.mjs', '// see also lib/check-shared.mjs for the details\n');
    write(root, 'scripts/lib/check-shared.mjs', '// nothing imports this\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/lib\/check-shared\.mjs/);
  });
});

/**
 * The fixture above shares a symmetry with the bug: its comment names the file
 * UNQUOTED, and the reference scan only ever matched quoted tokens, so it was
 * green either side of the comment-blanking. This repo's comment convention is
 * BACKTICKS around filenames — `check-test-wiring.mjs`'s own header names
 * `scripts/moonshot/diff-spike/verify-common.mjs` that way — and a backtick is
 * a quote. One line of prose in any already-wired script would otherwise buy an
 * unwired gate a pass.
 */
test('a BACKTICKED filename in prose is still prose — it confers no reach', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-wired.mjs', '/** Historical note: `scripts/check-evader.mjs` used to do this. */\n');
    write(root, 'scripts/check-evader.mjs', '// nothing runs this\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-evader\.mjs/);
  });
});

test("a quoted filename in a trailing `//` comment confers no reach either", () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-wired.mjs', "const x = 1; // replaces './check-evader.mjs'\n");
    write(root, 'scripts/check-evader.mjs', '// nothing runs this\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-evader\.mjs/);
  });
});

test('a URL inside a string is not read as a comment: real references beside it survive', () => {
  withTree({}, (root) => {
    write(
      root,
      'scripts/check-wired.mjs',
      "const DOCS = 'https://example.test/x';\nimport './lib/check-shared.mjs';\n",
    );
    write(root, 'scripts/lib/check-shared.mjs', '// imported by a wired gate\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

/**
 * 2a must not become satisfiable by 2b. A gate's own harness spawns the gate,
 * so following that edge would mean: wire the `node --test` step, forget the
 * gate step, and the gate that never runs against the REPO reads as wired.
 * That is #3062's failure with one of its two halves wired.
 */
test('a gate is NOT wired by its own test being wired', () => {
  withTree({
    extraSteps:
      '      - name: Evader gate regressions\n        run: node --test scripts/check-evader.test.mjs\n',
  }, (root) => {
    write(root, 'scripts/check-evader.mjs', '// a gate no workflow step runs\n');
    write(root, 'scripts/check-evader.test.mjs', "import './check-evader.mjs';\n");
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-evader\.mjs/);
    // The TEST is wired, so 2b must stay silent about it — only 2a fires.
    assert.doesNotMatch(out, /check-evader\.test\.mjs/);
  });
});

test('a module a wired TEST imports is not thereby wired for 2a', () => {
  withTree({
    extraSteps:
      '      - name: Evader gate regressions\n        run: node --test scripts/check-evader.test.mjs\n',
  }, (root) => {
    write(root, 'scripts/check-evader.test.mjs', "import './lib/check-helper.mjs';\n");
    write(root, 'scripts/lib/check-helper.mjs', '// only a test names this\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/lib\/check-helper\.mjs/);
  });
});

test('an unwired .js gate is caught — the extension is not an exemption', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-evader.js', '// a gate nothing runs, in CommonJS clothing\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-evader\.js/);
  });
});

test('a WIRED .js gate passes — widening the pattern demands wiring, it does not forbid .js', () => {
  withTree({
    extraSteps: '      - name: Check the js gate\n        run: node scripts/check-evader.js\n',
  }, (root) => {
    write(root, 'scripts/check-evader.js', '// a gate CI runs\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a non-gate .js script is not swept in by the widened pattern', () => {
  withTree({}, (root) => {
    write(root, 'scripts/sync-versions.js', '// not a check-/verify- name\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('naming `pnpm <script>` in a step NAME is not wiring — a label executes nothing', () => {
  withTree({
    rootScripts: { 'check:orphan': 'node scripts/check-orphan.mjs' },
    extraSteps: '      - name: this step does not run pnpm check:orphan\n        run: echo hello\n',
  }, (root) => {
    write(root, 'scripts/check-orphan.mjs', '// gate\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/check-orphan\.mjs/);
  });
});

test('wiring outside `run:` still counts: a `with:` input the action executes (verify-esm-entrypoints\' real shape)', () => {
  withTree({
    rootScripts: { release: 'pnpm test:esm', 'test:esm': 'node scripts/check-esm.mjs' },
    extraSteps: '      - uses: changesets/action@v1\n        with:\n          publish-script: pnpm run release\n',
  }, (root) => {
    write(root, 'scripts/check-esm.mjs', '// gate, reached through the publish script\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a one-line @unwired-by-design prints the reason without the comment terminator', () => {
  withTree({}, (root) => {
    write(root, 'scripts/check-local-only.mjs', '/** @unwired-by-design a local pre-push convenience */\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
    assert.match(out, /scripts\/check-local-only\.mjs — a local pre-push convenience$/m);
    assert.doesNotMatch(out, /a local pre-push convenience \*\//);
  });
});

/* ---------------------------------------------------------------- *
 * 2b: scripts/ test files.                                           *
 * ---------------------------------------------------------------- */

test('a scripts/ test in a subdirectory the single-level glob cannot reach is flagged', () => {
  withTree({}, (root) => {
    write(root, 'scripts/docs/check-doc-samples.test.mjs', '// unreachable by scripts/*.test.mjs\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/ test files no workflow runs/);
    assert.match(out, /scripts\/docs\/check-doc-samples\.test\.mjs/);
  });
});

// The remedy line tells the developer WHICH directories the catch-all reaches.
// It used to name `scripts/` and `scripts/lib/` as a hard-coded pair, written
// when those were the only two; `scripts/fixtures/` (#3038 follow-up) and
// `scripts/docs/` (#3200) were later added to the workflow glob and the advice
// was not. Advice that lags the thing it describes sends the developer to the
// wrong directory — so the message is DERIVED from the same `globDirs` the
// verdict is derived from, and this pins that the two cannot drift apart.
test('the remedy names every directory the catch-all actually covers, not a hard-coded pair', () => {
  withTree({
    extraSteps:
      '      - name: Wider catch-all\n' +
      '        run: node --test scripts/fixtures/*.test.mjs scripts/docs/*.test.mjs\n',
  }, (root) => {
    write(root, 'scripts/perf/bench.test.mjs', '// in none of the covered directories\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/perf\/bench\.test\.mjs/);
    for (const dir of ['scripts/', 'scripts/lib/', 'scripts/fixtures/', 'scripts/docs/']) {
      assert.ok(out.includes(`\`${dir}*.test.mjs\``), `remedy must name ${dir}, got:\n${out}`);
    }
  });
});

test('the same test named literally by a `node --test` step is wired', () => {
  withTree({
    extraSteps: '      - name: Doc samples\n        run: node --test scripts/docs/check-doc-samples.test.mjs\n',
  }, (root) => {
    write(root, 'scripts/docs/check-doc-samples.test.mjs', '// named\n');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a test path mentioned on a line that is not a `--test` invocation does not count as a runner', () => {
  withTree({
    extraSteps: '      - name: Upload\n        run: cp scripts/docs/check-doc-samples.test.mjs /tmp/\n',
  }, (root) => {
    write(root, 'scripts/docs/check-doc-samples.test.mjs', '// not run, just copied\n');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /scripts\/docs\/check-doc-samples\.test\.mjs/);
  });
});

/* ---------------------------------------------------------------- *
 * Part 1 behaviour, unchanged.                                       *
 * ---------------------------------------------------------------- */

test('a package with test files and no `test` script is still flagged', () => {
  withTree({}, (root) => {
    write(root, 'packages/beta/package.json', JSON.stringify({ name: '@ifc-lite/beta', scripts: { build: 'tsc' } }));
    write(root, 'packages/beta/src/beta.test.ts', 'test');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /Packages with test files but no `test` script/);
    assert.match(out, /@ifc-lite\/beta.*packages\/beta\/src\/beta\.test\.ts/s);
  });
});

test('a package with test files under a nested dir and a `test` script is not flagged', () => {
  withTree({}, (root) => {
    write(root, 'apps/gamma/package.json', JSON.stringify({ name: 'gamma', scripts: { test: 'vitest run' } }));
    write(root, 'apps/gamma/src/deep/gamma.spec.tsx', 'test');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('a package with no test files and no `test` script is not flagged', () => {
  withTree({}, (root) => {
    write(root, 'packages/delta/package.json', JSON.stringify({ name: 'delta', scripts: { build: 'tsc' } }));
    write(root, 'packages/delta/src/index.ts', 'export {};');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

test('test files under node_modules/dist do not make a package an offender', () => {
  withTree({}, (root) => {
    write(root, 'packages/eps/package.json', JSON.stringify({ name: 'eps', scripts: { build: 'tsc' } }));
    write(root, 'packages/eps/node_modules/x/x.test.js', 'test');
    write(root, 'packages/eps/dist/y.test.js', 'test');
    const { status, out } = run(root);
    assert.equal(status, 0, out);
  });
});

/* ---------------------------------------------------------------- *
 * Anti-vacuity: every "0 offenders" must mean "looked and found none". *
 * ---------------------------------------------------------------- */

test('a missing scripts/ search root fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'scripts'), { recursive: true });
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /no search root/);
  });
});

test('a scripts/ directory with no gate scripts fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'scripts/check-wired.mjs'));
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /found no check-\* \/ verify-\* script under/);
  });
});

test('a scripts/ directory with no *.test.mjs at all fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'scripts/check-wired.test.mjs'));
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /found no \*\.test\.mjs/);
  });
});

test('a missing packages//apps/ search root fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'packages'), { recursive: true });
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /no search root found/);
  });
});

test('a packages/ tree with no package.json in it fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'packages/alpha'), { recursive: true });
    mkdirSync(join(root, 'packages/empty'), { recursive: true });
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /found no package\.json under/);
  });
});

test('a missing workflow directory fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, '.github'), { recursive: true });
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /no workflow directory/);
  });
});

test('a workflow directory with no yaml in it fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, '.github/workflows/test.yml'));
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /contains no \.yml\/\.yaml files/);
  });
});

test('an unreadable workflow file fails closed rather than being read as empty', (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads every file regardless of mode');
  withTree({}, (root) => {
    const wf = join(root, '.github/workflows/test.yml');
    chmodSync(wf, 0o000);
    try {
      const { status, out } = run(root);
      assert.equal(status, 1, out);
      assert.match(out, /could not be read/);
    } finally {
      chmodSync(wf, 0o644);
    }
  });
});

test('a missing root package.json fails closed', () => {
  withTree({}, (root) => {
    rmSync(join(root, 'package.json'));
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /cannot resolve what/);
  });
});

test('an unparseable root package.json fails closed', () => {
  withTree({}, (root) => {
    writeFileSync(join(root, 'package.json'), '{ not json');
    const { status, out } = run(root);
    assert.equal(status, 1, out);
    assert.match(out, /is not valid JSON/);
  });
});

test('--root with no argument is rejected', () => {
  const r = spawnSync(process.execPath, [CHECKER, '--root'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--root requires a directory argument/);
});
