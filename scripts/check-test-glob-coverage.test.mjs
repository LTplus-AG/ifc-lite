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
 * Run: node --test scripts/check-test-glob-coverage.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
