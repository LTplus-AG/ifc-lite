#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Regression harness for scripts/check-test-glob-coverage.mjs.
 *
 * Method matches scripts/check-server-bin-targets.test.mjs: drive the
 * UNMODIFIED checker via `--root <dir>` against a synthetic package tree
 * built from scratch in a temp directory — never against this repo's real
 * packages. That keeps the fixtures small, and keeps a change to a real
 * package's test script or vitest config from silently breaking (or
 * silently un-breaking) this suite.
 *
 * Four fixture packages, four distinct (test-looking, matched) counts so no
 * case can pass by coincidence:
 *
 *   glob-miss       "tsx --test src/*.test.ts"    2 test-looking, 1 matched
 *   glob-full       "vitest run" (no config)      3 test-looking, 3 matched
 *   config-include  "vitest run" + vitest.config   4 test-looking, 2 matched
 *                   include: ['test/**\/*.test.ts']
 *   zero-tests      "vitest run"                   0 test-looking, 0 matched
 *
 * Two further cases cover anti-vacuity (#3194) rather than glob semantics: a
 * root with no package parents at all, and a package parent holding no
 * package.json. Both used to exit 0 with a success line.
 *
 * Run: node --test scripts/check-test-glob-coverage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp, parseViteInclude } from './check-test-glob-coverage.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const CHECKER = join(SCRIPTS, 'check-test-glob-coverage.mjs');

/** Writes { "packages/name/relpath": content } into a fresh temp tree. */
function writeTree(files) {
  const dir = mkdtempSync(join(tmpdir(), 'test-glob-coverage-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function runOn(dir) {
  const r = spawnSync(process.execPath, [CHECKER, '--root', dir], { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function pkgJson(testScript) {
  return JSON.stringify({ name: 'fixture', version: '0.0.0', scripts: { test: testScript } }, null, 2);
}

/** The four fixtures, each toggleable between "broken" and "fixed" glob. */
function fixtureFiles({ fixGlobMiss = false, fixConfigInclude = false } = {}) {
  const files = {
    // glob-miss: tsx --test src/*.test.ts — only reaches src/*.test.ts directly.
    'packages/glob-miss/package.json': pkgJson(
      fixGlobMiss ? "tsx --test src/*.test.ts src/nested/*.test.ts" : 'tsx --test src/*.test.ts',
    ),
    'packages/glob-miss/src/a.test.ts': '// test a\n',
    'packages/glob-miss/src/nested/b.test.ts': '// test b (nested — bare glob cannot see this)\n',

    // glob-full: plain `vitest run`, no config -> vitest's recursive default,
    // which reaches every test-looking file by construction.
    'packages/glob-full/package.json': pkgJson('vitest run'),
    'packages/glob-full/src/a.test.ts': '// test a\n',
    'packages/glob-full/src/nested/b.test.ts': '// test b\n',
    'packages/glob-full/src/nested/deep/c.test.ts': '// test c\n',

    // config-include: vitest run + vitest.config.ts include narrowed to test/**.
    'packages/config-include/package.json': pkgJson('vitest run'),
    'packages/config-include/vitest.config.ts': `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [${fixConfigInclude ? "'test/**/*.test.ts', 'src/**/*.test.ts'" : "'test/**/*.test.ts'"}],
  },
});
`,
    'packages/config-include/test/a.test.ts': '// test a\n',
    'packages/config-include/test/b.test.ts': '// test b\n',
    'packages/config-include/src/c.test.ts': '// test c (config include cannot see this)\n',
    'packages/config-include/src/d.test.ts': '// test d (config include cannot see this)\n',

    // zero-tests: a real package shape with no test-looking files at all.
    // Must not be reported as broken.
    'packages/zero-tests/package.json': pkgJson('vitest run'),
    'packages/zero-tests/src/index.ts': '// no tests here\n',
  };
  return files;
}

test('RED: broken glob-miss and config-include fixtures are both caught, with correct counts', () => {
  const dir = writeTree(fixtureFiles({ fixGlobMiss: false, fixConfigInclude: false }));
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, out);
    assert.match(out, /packages\/glob-miss: 1 unrun of 2 test-looking files \(1 matched\)/);
    assert.match(out, /packages\/glob-miss\/src\/nested\/b\.test\.ts/);
    assert.match(out, /packages\/config-include: 2 unrun of 4 test-looking files \(2 matched\)/);
    assert.match(out, /packages\/config-include\/src\/c\.test\.ts/);
    assert.match(out, /packages\/config-include\/src\/d\.test\.ts/);
    // The two clean fixtures must not appear as offenders.
    assert.doesNotMatch(out, /packages\/glob-full:/);
    assert.doesNotMatch(out, /packages\/zero-tests:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GREEN: widening both globs to cover every test-looking file makes the whole tree pass', () => {
  const dir = writeTree(fixtureFiles({ fixGlobMiss: true, fixConfigInclude: true }));
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-glob-coverage: OK \(4 packages audited, 0 unrun test files\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package with zero test-looking files never fails, regardless of its test script', () => {
  const dir = writeTree({
    'packages/zero-tests/package.json': pkgJson('vitest run'),
    'packages/zero-tests/src/index.ts': '// no tests here\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-glob-coverage: OK \(1 packages audited, 0 unrun test files\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a package with no `test` script at all is skipped, not flagged (that is check-test-wiring\'s job)', () => {
  const dir = writeTree({
    'packages/no-test-script/package.json': JSON.stringify({ name: 'fixture', scripts: {} }),
    'packages/no-test-script/src/a.test.ts': '// never wired to any script\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-glob-coverage: OK \(0 packages audited, 0 unrun test files\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unrecognised test-script shape fails closed instead of being silently waved through', () => {
  const dir = writeTree({
    'packages/mystery-runner/package.json': pkgJson('jest --config jest.config.js'),
    'packages/mystery-runner/src/a.test.ts': '// this repo has never used jest\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, out);
    assert.match(out, /unrecognised shape/);
    assert.match(out, /jest --config jest\.config\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a find-based recursive command (apps\\/viewer\'s shape) reaches nested test files', () => {
  const dir = writeTree({
    'packages/find-runner/package.json': pkgJson(
      "tsx --test $(find src -type f \\( -name '*.test.ts' -o -name '*.test.tsx' \\) | sort)",
    ),
    'packages/find-runner/src/a.test.ts': '// top level\n',
    'packages/find-runner/src/deep/nested/b.test.tsx': '// deeply nested, still reached\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-glob-coverage: OK \(1 packages audited, 0 unrun test files\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Anti-vacuity: a scan that found nothing must not report a clean audit ---
//
// Issue #3194: this checker printed `OK (0 packages audited, 0 unrun test
// files)` and exited 0 when pointed at a tree with no packages in it, so CI
// read "we looked and it was clean" from a run that had looked at nothing.
// Both shapes of nothing get a case, because they fail at different points.

test('vacuity: a root with neither packages/ nor apps/ fails instead of reporting a clean audit', () => {
  // mkdtemp gives a real, readable, EMPTY directory — the exact input that
  // used to exit 0.
  const dir = mkdtempSync(join(tmpdir(), 'test-glob-coverage-empty-'));
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, `expected a non-zero exit on an empty tree, got ${status}: ${out}`);
    assert.match(out, /Refusing a vacuous pass/);
    assert.match(out, /none of packages\/, apps\/ exists/);
    assert.doesNotMatch(out, /OK \(/, 'must not print a success line at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vacuity: a packages/ dir holding no package.json fails instead of reporting a clean audit', () => {
  const dir = writeTree({
    // A parent that exists but holds nothing this checker recognises as a
    // package: the walk succeeds, the package list comes back empty.
    'packages/not-a-package/README.md': '# no package.json here\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, `expected a non-zero exit on a package-less tree, got ${status}: ${out}`);
    assert.match(out, /Refusing a vacuous pass/);
    assert.match(out, /contain no directory with a package\.json/);
    assert.doesNotMatch(out, /OK \(/, 'must not print a success line at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an UNREADABLE package is not silently treated as an absent one', () => {
  // Package DISCOVERY used `existsSync`, which answers false for every
  // failure, EACCES included -- so a package the gate could not open dropped
  // out of the audit with no error. Measured before the fix, against a
  // `chmod 000` package carrying a real test script:
  //
  //   check-test-glob-coverage: OK (1 packages audited, 0 unrun test files)
  //   EXIT=0
  //
  // which is this gate's own "absence reads as success" defect, one stage
  // earlier than the walk it was fixed for.
  //
  // The fixture is a FILE where a package directory belongs, so `package.json`
  // underneath it fails with ENOTDIR. That is deliberate: `chmod 000` does not
  // stop root, and CI containers routinely run as root, so a permissions-based
  // fixture would pass here and quietly not test anything on the machine that
  // matters. ENOTDIR is the same "not ENOENT" branch and is deterministic for
  // every user.
  const dir = writeTree({
    'packages/real-one/package.json': JSON.stringify({ name: 'real-one', scripts: { test: 'vitest run' } }),
    'packages/real-one/src/a.test.ts': 'x',
    // Not a directory. Statting `packages/blocked/package.json` gives ENOTDIR.
    'packages/blocked': 'i am a file, not a package directory\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, `expected a non-zero exit on an unreadable package, got ${status}: ${out}`);
    assert.match(out, /cannot read package manifest/);
    assert.match(out, /Refusing to treat an unreadable path as an absent one/);
    assert.doesNotMatch(out, /OK \(/, 'must not print a success line at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Dotfiles are not candidate packages, and skipping them must not soften
//     the ENOTDIR refusal directly above ---
//
// macOS drops a `.DS_Store` FILE into `packages/` and `apps/` as soon as
// Finder opens them. Statting `packages/.DS_Store/package.json` raises
// ENOTDIR, so the refusal above fired on it and failed the whole Lint lane —
// observed in four separate fresh worktrees. CI never sees this (no Finder on
// the runners), so a green CI proves nothing about it either way; these two
// cases are where the pairing is pinned.
//
// They are deliberately a PAIR. Making the flake go away is trivial and has an
// obvious wrong fix (catch ENOTDIR and continue), which would delete the
// refusal this gate exists for. The second case is the one that would catch
// that: the same tree carries a dotfile AND a non-dotfile ENOTDIR candidate,
// and the gate must ignore exactly one of them and refuse the other.

test('a `.DS_Store` dotfile in packages/ or apps/ is not a candidate package (PR 3350)', () => {
  const dir = writeTree({
    'packages/real-one/package.json': pkgJson('vitest run'),
    'packages/real-one/src/a.test.ts': '// test a\n',
    'apps/real-app/package.json': pkgJson('vitest run'),
    'apps/real-app/src/b.test.ts': '// test b\n',
    // Finder's leavings: a FILE, so `<name>/package.json` gives ENOTDIR.
    'packages/.DS_Store': '\x00\x01Bud1',
    'apps/.DS_Store': '\x00\x01Bud1',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 0, out);
    assert.match(out, /check-test-glob-coverage: OK \(2 packages audited, 0 unrun test files\)/);
    assert.doesNotMatch(out, /DS_Store/, 'a dotfile must not appear in the output at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skipping dotfiles does not soften the refusal: a non-dotfile ENOTDIR candidate in the SAME tree still fails (PR 3350)', () => {
  const dir = writeTree({
    'packages/real-one/package.json': pkgJson('vitest run'),
    'packages/real-one/src/a.test.ts': '// test a\n',
    'packages/.DS_Store': '\x00\x01Bud1',
    // Not a dotfile, and not a directory: `packages/blocked/package.json`
    // raises ENOTDIR exactly as `.DS_Store` did. This one must still be
    // refused — that is the whole point of the guard.
    'packages/blocked': 'i am a file, not a package directory\n',
  });
  try {
    const { status, out } = runOn(dir);
    assert.equal(status, 1, `expected a non-zero exit on a non-dotfile ENOTDIR candidate, got ${status}: ${out}`);
    assert.match(out, /cannot read package manifest/);
    assert.match(out, /packages\/blocked\/package\.json/);
    assert.match(out, /Refusing to treat an unreadable path as an absent one/);
    assert.doesNotMatch(out, /DS_Store/, 'the dotfile must not be what tripped it');
    assert.doesNotMatch(out, /OK \(/, 'must not print a success line at all');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Direct unit tests on the exported glob helpers ---

test('globToRegExp: ** matches zero or more path segments', () => {
  const re = globToRegExp('test/**/*.test.ts');
  assert.ok(re.test('test/a.test.ts'), 'zero intermediate segments');
  assert.ok(re.test('test/nested/a.test.ts'), 'one intermediate segment');
  assert.ok(re.test('test/a/b/c.test.ts'), 'multiple intermediate segments');
  assert.ok(!re.test('src/a.test.ts'), 'wrong root dir');
  assert.ok(!re.test('test/a.spec.ts'), 'wrong suffix');
});

test('parseViteInclude: reads the first top-level include array, ignoring a nested typecheck.include', () => {
  const source = `export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    typecheck: { include: ['test/**/*.test.ts'] },
  },
});`;
  assert.deepEqual(parseViteInclude(source), ['test/**/*.test.ts']);
});

test('parseViteInclude: returns null when there is no include key (vitest default applies)', () => {
  assert.equal(parseViteInclude('export default defineConfig({ test: {} });'), null);
});

test('an unreadable vitest config is reported by the gate, not as a raw stack', (t) => {
  // Windows chmod does not remove read permission, and root ignores the mode
  // bits, so on either the config stays readable and the case cannot be built.
  if (process.platform === 'win32') return t.skip('chmod does not gate reads on Windows');
  if (process.getuid?.() === 0) return t.skip('root reads a 000 file regardless of mode');

  const files = {
    'packages/fixture/package.json': pkgJson('vitest run'),
    'packages/fixture/src/a.test.ts': 'test("a", () => {})',
    'packages/fixture/vitest.config.ts': 'export default { test: { include: ["src/**/*.test.ts"] } }',
  };
  const dir = writeTree(files);
  const config = join(dir, 'packages/fixture/vitest.config.ts');

  try {
    // BOTH directions. Readable first, so a fixture that fails for some
    // unrelated reason cannot be mistaken for the refusal firing. Inside the
    // try, or a failure here leaks the tree instead of cleaning up.
    const readable = runOn(dir);
    assert.equal(readable.status, 0, `readable config should audit cleanly:\n${readable.out}`);

    chmodSync(config, 0o000);
    const locked = runOn(dir);
    assert.equal(locked.status, 1, 'an unreadable config must fail the gate');
    assert.match(locked.out, /cannot read vitest config/);
    // The point of the change. It already exited 1 before; what it did NOT do
    // was say why, and an uncaught readFileSync stack sends the reader into
    // node internals instead of at their own file mode.
    //
    // Matched on the payload rather than a `at readFileSync (node:fs` frame:
    // V8 names the frame after the call form, so the frame spelling is voided
    // by a change to how this gate imports fs. See the sibling in
    // check-test-wiring.test.mjs, which was vacuous for that exact reason.
    assert.doesNotMatch(locked.out, /permission denied, open/, 'must not surface a raw node error');
  } finally {
    chmodSync(config, 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--root with no argument is refused cleanly, without a raw stack', () => {
  // This runs during MODULE EVALUATION, before the entry point's try/catch
  // exists, so a `fail` here escapes and prints a stack on top of the message.
  // It did exactly that, two ways at once: `class FailError` was declared below
  // `fail`, so the throw was a ReferenceError from the temporal dead zone.
  // check-test-wiring.test.mjs has always had this case; this file did not,
  // which is why a gate whose own tests forbid raw stacks was printing one.
  const r = spawnSync(process.execPath, [CHECKER, '--root'], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 1, 'a missing --root argument must fail the gate');
  assert.match(out, /--root requires a directory argument/);
  assert.doesNotMatch(out, /ReferenceError/, 'must not die in the temporal dead zone');
  assert.doesNotMatch(out, /\n\s+at /, 'must not surface a raw node stack');
});
