#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Unit tests for `vitest-timeout-audit.mjs` (#2948), against SYNTHETIC
 * source snippets written for this file — never against this repo's real
 * test files. Reading a real file and asserting on its text is exactly the
 * substitution `scripts/check-source-text-assertions.mjs` exists to reject;
 * these fixtures instead pin the AUDIT TOOL'S behaviour against inputs
 * engineered to hit each of its documented failure modes, which is testing
 * the tool, not asserting a fact about unrelated production/test source.
 *
 * The two defects this guards against are the two #2947 actually made:
 * scoring an OPTIONS-OBJECT timeout as absent (grep for the trailing form
 * only), and scoring a MULTI-LINE trailing timeout as absent (grep for a
 * single-line trailing form). Both are represented below, alongside the
 * decoys that would fool a naive text search into a FALSE explicit-timeout
 * reading (a number inside a callback body; the words "60_000" inside a
 * comment or a string).
 *
 * Run: node --test scripts/lib/vitest-timeout-audit.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditFile,
  auditSource,
  classifyExplicitTimeout,
  findPackageConfigTimeout,
  findUnparsedCallSites,
  hasExplicitTimeout,
  isVitestTestFile,
  resolveConfigTimeout,
  stripNoise,
} from './vitest-timeout-audit.mjs';

function protectedNames(source) {
  return auditSource(source).filter((r) => r.protectedBy !== null).map((r) => r.name);
}
function unprotectedNames(source) {
  return auditSource(source).filter((r) => r.protectedBy === null).map((r) => r.name);
}

// ---- The three spellings, all recognised.

test('trailing form, single line', () => {
  const src = `it('a', () => { doWork(); }, 60_000);`;
  assert.deepEqual(unprotectedNames(src), []);
  const [r] = auditSource(src);
  assert.equal(r.form, 'trailing');
  assert.equal(r.value, 60000);
});

test('trailing form, split across lines (the #2947 multi-line spelling)', () => {
  const src = `it('a', () => {\n  doWork();\n},\n  60_000,\n);`;
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.form, 'trailing');
  assert.equal(r.value, 60000);
});

test('trailing form preceded by a comment justifying the number (the tri-mesh.test.ts shape found auditing #2948-adjacent work)', () => {
  // The multi-line case above puts nothing but whitespace before the
  // literal. This is the harder real shape: one or more full comment LINES
  // sit between the callback's closing `}` and the trailing number, which
  // is exactly `argTexts[last].trim()` failing NUMERIC_RE if the comment
  // text is not stripped first — this was a real false "NO EXPLICIT
  // TIMEOUT" on an already-protected test until fixed.
  const src = `it('a', () => {\n  doWork();\n},\n  // 32 288 probes x an all-triangle scan each.\n  // sized for a contended CI runner.\n  60_000,\n);`;
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.form, 'trailing');
  assert.equal(r.value, 60000);
});

test('options-object form (the #2947 blocked-source-equivalence.test.ts shape)', () => {
  const src = `it('a', { timeout: 60_000 }, () => { doWork(); });`;
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.form, 'options-object');
  assert.equal(r.value, 60000);
});

test('options-object form with other keys before timeout', () => {
  const src = `it('a', { retry: 2, timeout: 7000 }, () => {});`;
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.value, 7000);
});

// ---- The two #2947 mistakes, reproduced as regression cases.

test('a single-idiom grep for the trailing form would miss the options-object form — this does not', () => {
  const src = `it('agrees with the resident source', { timeout: 60_000 }, () => {});`;
  assert.ok(!/,\s*\d[\d_]*\s*\)\s*;?\s*$/.test(src.trim()), 'sanity: this source really has no trailing-number spelling');
  assert.equal(unprotectedNames(src).length, 0);
});

test('a single-idiom grep for a single-line trailing number would miss the multi-line form — this does not', () => {
  const src = `it('b', () => {\n  work();\n},\n    60_000,\n  );`;
  assert.ok(!/\},\s*\d[\d_]*\s*\);/.test(src), 'sanity: no single-line trailing-number spelling appears in this source');
  assert.equal(unprotectedNames(src).length, 0);
});

// ---- No explicit timeout at all.

test('no third argument at all is unprotected', () => {
  const src = `it('a', () => { doWork(); });`;
  assert.deepEqual(protectedNames(src), []);
});

test('options object with no timeout key is unprotected', () => {
  const src = `it('a', { retry: 2 }, () => {});`;
  assert.deepEqual(protectedNames(src), []);
});

// ---- Decoys that would fool naive text search into a FALSE positive.

test('a number that is really inside the callback BODY (only 2 top-level args) is not mistaken for a timeout', () => {
  const src = `it('a', () => { setTimeout(cb, 60000); });`;
  assert.deepEqual(protectedNames(src), []);
});

test('the digits "60_000" inside a comment do not count as a timeout', () => {
  const src = `it('a', () => {\n  // used to be 60_000 here\n  doWork();\n});`;
  assert.deepEqual(protectedNames(src), []);
});

test('the digits "60000" inside a string literal (e.g. a test name) do not count as a timeout', () => {
  const src = `it('completes within 60000 units', () => { doWork(); });`;
  assert.deepEqual(protectedNames(src), []);
});

test('a comma inside a string argument does not fool the argument splitter', () => {
  const src = `it('a, b, c', () => { doWork(); });`;
  const [r] = auditSource(src);
  assert.equal(r.name, 'a, b, c');
  assert.equal(r.protectedBy, null);
});

// ---- Named-constant timeouts (this repo's own convention, e.g. `gym.test.ts`'s
// `AB22_TIMEOUT_MS`, and this fix's own `WORKER_IMPORT_HOOK_TIMEOUT_MS` /
// `YIELD_HEAVY_TIMEOUT_MS`) — a bare identifier is still an explicit timeout,
// just one this lexical scan cannot resolve to a number without evaluating
// the module. Found by running the tool against gym.test.ts itself, where an
// earlier numeric-literal-only version wrongly reported two describe.skipIf
// children as unprotected despite `{ timeout: AB22_TIMEOUT_MS }` on the
// enclosing describe.

test('a named constant as the trailing timeout argument is explicit, with valueRef set instead of value', () => {
  const src = 'const T = 30_000;\nit("a", () => {}, T);';
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.form, 'trailing');
  assert.equal(r.value, null);
  assert.equal(r.valueRef, 'T');
});

test('a named constant as an options-object timeout value is explicit, with valueRef set', () => {
  const src = "const AB22_TIMEOUT_MS = 30_000;\ndescribe('s', { timeout: AB22_TIMEOUT_MS }, () => {\n  it('a', () => {});\n});";
  const [r] = auditSource(src).filter((x) => x.keyword === 'it');
  assert.equal(r.protectedBy, "describe:s");
  assert.equal(r.value, null);
  assert.equal(r.valueRef, 'AB22_TIMEOUT_MS');
});

test('an arrow-function trailing argument (the callback itself, not a timeout) is never mistaken for a named-constant timeout', () => {
  // Only 2 real top-level args here even though the source has 3 commas at
  // first glance — this pins that a callback body is not misread as a bare
  // identifier because it is not one syntactically ("() => {}" fails
  // IDENTIFIER_RE), so classifyExplicitTimeout falls through correctly.
  const src = "it('a', function named() { doWork(); });";
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, null);
});

// ---- describe-level inheritance (the gap a per-`it`-only checker has —
// found while investigating #2948, verified behaviourally against real
// vitest: a describe-level `{ timeout }` really is enforced on children).

test('an it with no timeout of its own, nested in a describe that has one, is protected', () => {
  const src = `describe('suite', { timeout: 30000 }, () => {\n  it('a', () => { doWork(); });\n});`;
  const [r] = auditSource(src).filter((x) => x.keyword === 'it');
  assert.equal(r.protectedBy, 'describe:suite');
  assert.equal(r.value, 30000);
});

test('an it WITH its own timeout wins over an enclosing describe timeout', () => {
  const src = `describe('suite', { timeout: 30000 }, () => {\n  it('a', () => {}, 5000);\n});`;
  const [r] = auditSource(src).filter((x) => x.keyword === 'it');
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.value, 5000);
});

test('nesting: the nearest enclosing describe with a timeout wins, not the outermost', () => {
  const src = [
    "describe('outer', { timeout: 90000 }, () => {",
    "  describe('inner', { timeout: 15000 }, () => {",
    "    it('a', () => {});",
    '  });',
    '});',
  ].join('\n');
  const [r] = auditSource(src).filter((x) => x.keyword === 'it');
  assert.equal(r.protectedBy, 'describe:inner');
  assert.equal(r.value, 15000);
});

test('a sibling describe with a timeout does NOT leak into an unrelated describe with none', () => {
  const src = [
    "describe('a', { timeout: 30000 }, () => { it('x', () => {}); });",
    "describe('b', () => { it('y', () => {}); });",
  ].join('\n');
  const results = auditSource(src).filter((r) => r.keyword === 'it');
  const y = results.find((r) => r.name === 'y');
  assert.equal(y.protectedBy, null);
});

// ---- Modifier chains: `.skipIf(...)`, `.each(...)`, `.only`, plain dotted forms.

test('describe.skipIf(cond)(name, { timeout }, fn) — the parenthesized modifier does not confuse the args scan', () => {
  const src = "describe.skipIf(!AVAILABLE)('suite', { timeout: 30000 }, () => {\n  it('a', () => {});\n});";
  const [r] = auditSource(src).filter((x) => x.keyword === 'it');
  assert.equal(r.protectedBy, 'describe:suite');
});

test('it.each([...])(name, fn, timeout) — the parenthesized .each(...) modifier is skipped before the real arg list', () => {
  const src = "it.each([1, 2])('case %d', (n) => { use(n); }, 12_000);";
  const [r] = auditSource(src);
  assert.equal(r.keyword, 'it');
  assert.equal(r.protectedBy, 'own');
  assert.equal(r.value, 12000);
});

test('it.only with no timeout is still detected as unprotected', () => {
  const src = "it.only('a', () => { doWork(); });";
  const [r] = auditSource(src);
  assert.equal(r.protectedBy, null);
});

// ---- Regex literal in the callback body must not corrupt paren depth.

test('a regex literal containing a closing paren inside the test body does not break argument-boundary detection', () => {
  const src = "it('a', () => { const re = /\\)/; return re.test(x); });";
  const [r] = auditSource(src);
  assert.equal(r.name, 'a');
  assert.equal(r.protectedBy, null); // only 2 top-level args — correctly so, not corrupted into more
});

// ---- classifyExplicitTimeout directly.

test('classifyExplicitTimeout: underscored numeric literal parses to its numeric value', () => {
  assert.deepEqual(classifyExplicitTimeout(["'a'", '() => {}', '120_000']), {
    explicit: true, form: 'trailing', value: 120000,
  });
});

test('classifyExplicitTimeout: fewer than 2 args is never explicit', () => {
  assert.deepEqual(classifyExplicitTimeout(["'a'"]), { explicit: false, form: null, value: null });
});

// ---- hasExplicitTimeout: the single-question API.

test('hasExplicitTimeout finds a named test and answers true/false correctly', () => {
  const src = "describe('s', { timeout: 9000 }, () => {\n  it('protected', () => {});\n});";
  assert.equal(hasExplicitTimeout(src, 'protected'), true);
});

test('hasExplicitTimeout returns null (not false) for a test name that is not present, distinguishing "not found" from "not protected"', () => {
  const src = "it('a', () => {});";
  assert.equal(hasExplicitTimeout(src, 'nonexistent'), null);
});

// ---- stripNoise: line numbers survive comment/string stripping.

test('stripNoise preserves length and newlines exactly (line-number safety for callers)', () => {
  const src = "it('a /* not a real comment */', () => {\n  // line 2\n  doWork();\n});";
  const clean = stripNoise(src);
  assert.equal(clean.length, src.length);
  assert.equal((clean.match(/\n/g) || []).length, (src.match(/\n/g) || []).length);
});

// ---- CONFIG-LEVEL protection: the blind spot fixed after #2948 shipped.
// `packages/data` and `packages/create-ifc-lite` both set a package-wide
// `testTimeout` in `vitest.config.ts`, protecting every test in the
// package with no `it`/`describe`-level signal at all — 193 real calls,
// confirmed by running this tool against the actual repo. These fixtures
// are synthetic package roots built in a temp directory per
// `check-source-text-assertions.mjs`'s convention: the tool is exercised
// against engineered inputs, never against this repo's real test files.

function makeSyntheticPackage(files) {
  const root = mkdtempSync(join(tmpdir(), 'vitest-timeout-audit-config-'));
  for (const [relPath, contents] of Object.entries(files)) {
    const full = join(root, relPath);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

test('resolveConfigTimeout: a bare numeric testTimeout resolves to its value', () => {
  const src = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n    testTimeout: 30_000,\n  },\n});\n";
  assert.deepEqual(resolveConfigTimeout(src), { determined: true, value: 30000 });
});

test('resolveConfigTimeout: no testTimeout key at all resolves to null', () => {
  const src = "import { defineConfig } from 'vitest/config';\nexport default defineConfig({\n  test: {\n    environment: 'node',\n  },\n});\n";
  assert.equal(resolveConfigTimeout(src), null);
});

test('resolveConfigTimeout: a named identifier is reported as undetermined, not guessed protected or unprotected', () => {
  const src = "import { DEFAULT_TIMEOUT_MS } from './constants.js';\nexport default { test: { testTimeout: DEFAULT_TIMEOUT_MS } };\n";
  assert.deepEqual(resolveConfigTimeout(src), { determined: false, value: null });
});

test('resolveConfigTimeout: a computed expression is reported as undetermined', () => {
  const src = 'export default { test: { testTimeout: process.env.CI ? 30_000 : 5_000 } };';
  assert.deepEqual(resolveConfigTimeout(src), { determined: false, value: null });
});

// Fixture 1: a package with a config-level testTimeout — every it with no
// own/describe timeout is protected via config, and the value is shown.
test('auditFile fixture 1: package-level testTimeout protects a call with no own timeout', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-config"}',
    'vitest.config.ts': "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { testTimeout: 30_000 } });\n",
    'src/slow.test.ts': "import { it } from 'vitest';\nit('is slow but covered', () => { doWork(); });\n",
  });
  try {
    const testFile = join(root, 'src/slow.test.ts');
    const [r] = auditFile(testFile, "import { it } from 'vitest';\nit('is slow but covered', () => { doWork(); });\n");
    assert.equal(r.protectedBy, 'config');
    assert.equal(r.form, 'config');
    assert.equal(r.value, 30000);
    assert.equal(r.configPath, join(root, 'vitest.config.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture 2: a package whose vitest.config.ts sets no testTimeout — the
// call stays unprotected, config presence alone is not protection.
test('auditFile fixture 2: a config file with no testTimeout key leaves the call unprotected', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-no-timeout-key"}',
    'vitest.config.ts': "export default { test: { environment: 'node' } };\n",
    'src/plain.test.ts': "it('has no timeout anywhere', () => { doWork(); });\n",
  });
  try {
    const testFile = join(root, 'src/plain.test.ts');
    const [r] = auditFile(testFile, "it('has no timeout anywhere', () => { doWork(); });\n");
    assert.equal(r.protectedBy, null);
    assert.equal(r.configStatus, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture 3: both signals present — a per-call timeout inside a
// config-covered package. The own timeout must win and be reported as
// 'own', not silently reattributed to config — the two signals must stay
// distinguishable.
test('auditFile fixture 3: an own timeout inside a config-covered package is reported as own, not config', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-both-signals"}',
    'vitest.config.ts': "export default { test: { testTimeout: 30_000 } };\n",
    'src/both.test.ts': "it('has its own timeout too', () => { doWork(); }, 9000);\n",
  });
  try {
    const testFile = join(root, 'src/both.test.ts');
    const [r] = auditFile(testFile, "it('has its own timeout too', () => { doWork(); }, 9000);\n");
    assert.equal(r.protectedBy, 'own');
    assert.equal(r.form, 'trailing');
    assert.equal(r.value, 9000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture 4: a config whose testTimeout value cannot be determined
// statically — reported as its own 'unknown' bucket, not flipped to
// protected (would repeat the exact mistake being fixed) or silently
// folded into plain unprotected (would hide that a config override exists).
test('auditFile fixture 4: an undeterminable config value is reported as config-unknown, not protected or plain-unprotected', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-undeterminable"}',
    'vitest.config.ts': "import { TIMEOUT_MS } from './shared.js';\nexport default { test: { testTimeout: TIMEOUT_MS } };\n",
    'src/unclear.test.ts': "it('timeout value cannot be resolved', () => { doWork(); });\n",
  });
  try {
    const testFile = join(root, 'src/unclear.test.ts');
    const [r] = auditFile(testFile, "it('timeout value cannot be resolved', () => { doWork(); });\n");
    assert.equal(r.protectedBy, null);
    assert.equal(r.configStatus, 'unknown');
    assert.equal(r.configPath, join(root, 'vitest.config.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Fixture 5: a package with no vitest.config.* / vite.config.* at all —
// findPackageConfigTimeout must stop at the package.json boundary and
// return null, not walk further up and pick up an unrelated ancestor
// config.
test('auditFile fixture 5: a package with no config file at all is unprotected, with no config fields set', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-no-config"}',
    'src/bare.test.ts': "it('nothing protects this', () => { doWork(); });\n",
  });
  try {
    const testFile = join(root, 'src/bare.test.ts');
    const result = findPackageConfigTimeout(testFile);
    assert.equal(result, null);
    const [r] = auditFile(testFile, "it('nothing protects this', () => { doWork(); });\n");
    assert.equal(r.protectedBy, null);
    assert.equal(r.configStatus, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: a package-config lookup cache that keys on the intermediate
// "no config found in THIS directory" answer, rather than the FINAL
// resolved answer, wrongly caches `null` for a subdirectory during the
// first file's walk-up to the package root — before the walk ever reaches
// the config that actually governs it. Every sibling test file below that
// subdirectory then hits the stale cached `null` and never resolves the
// real config. Caught by running this tool against the real repo: only the
// first `packages/data/src/*.test.ts` file processed came back
// config-protected; the other 13 siblings in the same `src/` directory did
// not. This fixture reproduces that shape with two sibling files sharing a
// `src/` directory one level below the package root.
test('auditFile: a second sibling test file in the same subdirectory also resolves the package config (cache does not stick on the intermediate miss)', () => {
  const root = makeSyntheticPackage({
    'package.json': '{"name":"fixture-pkg-cache-regression"}',
    'vitest.config.ts': "export default { test: { testTimeout: 30_000 } };\n",
    'src/first.test.ts': "it('first sibling', () => { doWork(); });\n",
    'src/second.test.ts': "it('second sibling', () => { doWork(); });\n",
  });
  try {
    const firstFile = join(root, 'src/first.test.ts');
    const secondFile = join(root, 'src/second.test.ts');
    const [r1] = auditFile(firstFile, "it('first sibling', () => { doWork(); });\n");
    assert.equal(r1.protectedBy, 'config');
    assert.equal(r1.value, 30000);
    const [r2] = auditFile(secondFile, "it('second sibling', () => { doWork(); });\n");
    assert.equal(r2.protectedBy, 'config');
    assert.equal(r2.value, 30000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── Standalone CLI: it must not report a vacuous pass ────────────────────────
//
// The summary line is four counts. When every one of them is zero the run
// LOOKS like a clean report, and before the guard below the process still
// exited 0 — a tool that read nothing and said so in the same shape it uses
// to say "all good". Same failure class as `check-tla-chunk-await.mjs`
// printing `0 chunks…` against an unbuilt dist. These tests drive the real
// script as a subprocess (the guard lives in its `import.meta.url ===
// argv[1]` block, so importing the module cannot reach it) and, in keeping
// with this file's rule, hand it SYNTHETIC files only.

const SCRIPT = fileURLToPath(new URL('./vitest-timeout-audit.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

test('CLI: no file arguments exits non-zero instead of printing an all-zero summary', () => {
  const run = runCli([]);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing a vacuous pass/);
  assert.match(run.stderr, /no file arguments/);
  // The zero summary must not be printed at all — its absence is the point.
  assert.doesNotMatch(run.stdout, /summary:/);
});

test('CLI: a file holding no describe/it/test token at all exits non-zero rather than summarising zero of everything', () => {
  const root = makeSyntheticPackage({
    'not-a-test.ts': 'export const value = 1;\n',
  });
  try {
    const run = runCli([join(root, 'not-a-test.ts')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing a vacuous pass/);
    assert.doesNotMatch(run.stdout, /summary:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: a file with at least one call site still exits 0 and summarises it (the guard does not over-fire)', () => {
  const root = makeSyntheticPackage({
    'one.test.ts': "it('audited', () => { doWork(); }, 60_000);\n",
  });
  try {
    const run = runCli([join(root, 'one.test.ts')]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /summary: 1 protected \(own call\/describe\)/);
    assert.equal(run.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// -- Regex literals must not swallow the file --------------------------------
//
// `stripNoise` blanks strings so their contents cannot be mistaken for
// structure. A regex literal is NOT blanked (it can sit right against real
// call syntax), so it has to be stepped over as one token instead - before
// that, an apostrophe inside a pattern opened a phantom string that ran to
// the end of the file, `findMatchingParen` then failed, and EVERY call site
// in the file disappeared, including the ones written BEFORE the regex.

test('a regex containing an apostrophe does not swallow the rest of the file', () => {
  const src = [
    "const LEADING_QUOTE = /^'/;",
    "it('first', () => { doWork(); });",
    "it('second', () => { doWork(); });",
  ].join('\n');
  assert.deepEqual(auditSource(src).map((r) => r.name), ['first', 'second']);
});

test('call sites written AFTER an apostrophe-bearing regex are still found', () => {
  const src = [
    "it('before', () => { expect(cell).toMatch(/^'/); });",
    "it('after', () => { doWork(); }, 60_000);",
  ].join('\n');
  assert.deepEqual(unprotectedNames(src), ['before']);
  assert.deepEqual(protectedNames(src), ['after']);
});

test('a regex containing a backtick or a quote is equally opaque', () => {
  const src = [
    "it('backtick', () => { expect(s).toMatch(/^`/); });",
    "it('quote', () => { expect(s).toMatch(/^\"/); });",
  ].join('\n');
  assert.deepEqual(auditSource(src).map((r) => r.name), ['backtick', 'quote']);
});

test('a regex containing an unbalanced paren still does not corrupt the call it sits in', () => {
  const src = "it('paren', () => { expect(s).toMatch(/^\\)'/); }, 60_000);\nit('next', () => { doWork(); });";
  assert.deepEqual(protectedNames(src), ['paren']);
  assert.deepEqual(unprotectedNames(src), ['next']);
});

test('a slash that is division after a string literal is not read as a regex opening', () => {
  // A blanked string is indistinguishable from whitespace, so without
  // tracking where the literal ended the `=` before it would make this `/`
  // look like a regex start and the `'` on the next line would open a
  // phantom string.
  const src = [
    "const ratio = 'ab'.length / 2;",
    "const label = 'plain';",
    "it('after division', () => { doWork(); });",
  ].join('\n');
  assert.deepEqual(auditSource(src).map((r) => r.name), ['after division']);
});

test('stripNoise leaves a regex literal in place and keeps offsets stable', () => {
  const src = "const re = /a'b/;\nit('x', () => {});\n";
  const clean = stripNoise(src);
  assert.equal(clean.length, src.length);
  assert.match(clean, /\/a'b\//);
  // The string in `it('x', ...)` is still blanked - only the regex survives.
  assert.match(clean, /it\( {3},/);
});

// -- TypeScript type-argument lists on the call or its modifier --------------
//
// `it.each([...])` was recognised; `it.each<[Role, boolean]>([...])` was not,
// because the `<...>` sits between the modifier name and its argument list, so
// the parser never found the `(` it was looking for and dropped the call.

test('typed it.each is recognised (the untyped form already was)', () => {
  const untyped = "it.each([['a', true]])('role=%s', (r, w) => { doWork(); });";
  const typed = "it.each<[Role, boolean]>([['a', true]])('role=%s', (r, w) => { doWork(); });";
  assert.deepEqual(auditSource(untyped).map((r) => r.name), ['role=%s']);
  assert.deepEqual(auditSource(typed).map((r) => r.name), ['role=%s']);
});

test('a typed it.each still has its timeout classified, not just its name', () => {
  const src = "it.each<[Role, boolean]>([['a', true]])('role=%s', (r, w) => { doWork(); }, 60_000);";
  const [r] = auditSource(src);
  assert.equal(r.form, 'trailing');
  assert.equal(r.value, 60000);
});

test('a type-argument list holding a function type does not close early', () => {
  const src = "describe.each<(a: string) => void>([fn])('suite', () => { it('x', () => {}); });";
  assert.deepEqual(auditSource(src).map((r) => r.name), ['x']);
});

test('a type-argument list on the call itself is stepped over', () => {
  const src = "test<MyCtx>('typed call', () => { doWork(); }, 60_000);";
  assert.deepEqual(protectedNames(src), ['typed call']);
});

test('a less-than that is a comparison, not a type-argument list, is not read as a call', () => {
  const src = "if (it < 3) { doWork(); }\nit('real', () => { doWork(); });";
  assert.deepEqual(auditSource(src).map((r) => r.name), ['real']);
});

// -- The immediately-invoked parenthesized form ------------------------------

test('(cond ? it : it.skip)(...) is counted exactly once', () => {
  const src = "(hasBuild ? it : it.skip)('conditional', () => { doWork(); }, 60_000);";
  assert.deepEqual(protectedNames(src), ['conditional']);
  assert.equal(auditSource(src).length, 1);
});

// -- Files with no literal call site of their own ----------------------------

test('isVitestTestFile separates a describe-only suite runner from a non-test file', () => {
  const runner = "import { describe } from 'vitest';\ndescribe('X conformance', () => runConformanceSuite(fixtures));\n";
  assert.equal(isVitestTestFile(runner), true);
  assert.deepEqual(auditSource(runner), []);
  assert.equal(isVitestTestFile('export const value = 1;\n'), false);
  // A keyword appearing only inside a comment or a string does not count.
  assert.equal(isVitestTestFile("// describe it test\nconst s = 'it';\n"), false);
});

test('findUnparsedCallSites reports a call site it could not parse, and nothing otherwise', () => {
  assert.deepEqual(findUnparsedCallSites("it('fine', () => { doWork(); });\n"), []);
  const broken = "it('unterminated', () => { doWork(); };\n";
  const unparsed = findUnparsedCallSites(broken);
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].keyword, 'it');
  assert.equal(unparsed[0].line, 1);
});

test('CLI: a describe-only shared-suite runner exits 0 with an all-zero summary, not an error', () => {
  // The regression this pins: the vacuous-run guard used to fail any file
  // holding zero literal `it`/`test` call sites, which failed seven real
  // vitest test files in this repo. A `describe` that delegates to a shared
  // suite declares its tests at run time; refusing it is a false positive,
  // and narrowing the guard to "no describe/it/test token at all" keeps a
  // genuinely wrong path failing (see the test above) while letting this
  // legitimate shape through.
  const root = makeSyntheticPackage({
    'conformance.test.ts': "import { describe } from 'vitest';\ndescribe('X conformance', () => runConformanceSuite(fixtures));\n",
  });
  try {
    const run = runCli([join(root, 'conformance.test.ts')]);
    assert.equal(run.status, 0);
    assert.match(run.stdout, /summary: 0 protected \(own call\/describe\)/);
    assert.equal(run.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: an unparseable call site fails with its own message, not "check your paths"', () => {
  const root = makeSyntheticPackage({
    'broken.test.ts': "it('unterminated', () => { doWork(); };\n",
  });
  try {
    const run = runCli([join(root, 'broken.test.ts')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /could not be\s+parsed/);
    assert.match(run.stderr, /blind spot in this module's parser/);
    // The wrong-paths message would send the reader hunting the wrong thing.
    assert.doesNotMatch(run.stderr, /Check that the paths point at vitest test/);
    assert.doesNotMatch(run.stdout, /summary:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// -- Regressions found by an independent TypeScript-AST cross-check ---------
//
// Every test below was written RED against the version of this module that
// shipped `hasTestKeywordToken` (bare-token presence) and the angle-only
// `skipTypeArguments`, and each names the concrete wrong answer it pins.

test('the vacuous-pass guard rejects a production module whose only describe sits inside a function', () => {
  // A shared-suite MODULE (`export function runXConformance() { describe(...) }`)
  // registers nothing when vitest loads it, so auditing it alone classifies
  // nothing — exactly the all-zero summary the guard exists to refuse. The
  // token-presence guard accepted it.
  const suiteModule = [
    "import { describe } from 'vitest';",
    'export function runConformanceSuite(provider) {',
    "  describe('FileSourceProvider conformance', () => {",
    '    describeManifestConformance(provider);',
    '  });',
    '}',
  ].join('\n');
  assert.equal(isVitestTestFile(suiteModule), false);
});

test('the vacuous-pass guard rejects a production module that merely uses `it` as a local variable', () => {
  // `packages/renderer/src/scene.ts`'s shape, reduced: a `for (const it of …)`
  // loop whose body calls a method on `it`. There is no vitest here at all,
  // but `it.vertexBuffer.destroy()` matches the lexical call-site pattern.
  const production = [
    'export function destroyAll(templates) {',
    '  for (const it of templates) {',
    '    if (!it) continue;',
    '    it.vertexBuffer.destroy();',
    '  }',
    '}',
  ].join('\n');
  assert.equal(isVitestTestFile(production), false);
});

test('the vacuous-pass guard still accepts a describe-wrapped shared-suite runner, including inside a loop', () => {
  const flat = "import { describe } from 'vitest';\ndescribe('X conformance', () => runConformanceSuite(fixtures));\n";
  assert.equal(isVitestTestFile(flat), true);
  // `packages/source-fixture/test/fixture.test.ts`'s shape: the top-level
  // `describe` sits inside two `for` loops. A block statement is not a
  // function body, so this still runs at import time.
  const looped = [
    "import { describe } from 'vitest';",
    'for (const mode of modes) {',
    '  for (const recursive of recursionModes) {',
    "    describe(`mode=${mode}`, () => { runConformanceSuite(provider); });",
    '  }',
    '}',
  ].join('\n');
  assert.equal(isVitestTestFile(looped), true);
});

test('the vacuous-pass guard accepts a file holding a literal it/test call, wherever it sits', () => {
  assert.equal(isVitestTestFile("it('x', () => { doWork(); });\n"), true);
  // A shared-suite module that DOES declare `it` call sites is auditable —
  // those calls have a timeout status to report.
  const withIts = [
    "import { describe, it } from 'vitest';",
    'export function describeManifestConformance(provider) {',
    "  describe('manifest', () => { it('declares its capabilities', () => { doWork(); }); });",
    '}',
  ].join('\n');
  assert.equal(isVitestTestFile(withIts), true);
});

test('the vacuous-pass guard rejects a describe-only runner that never imports vitest', () => {
  // Without the import there is no evidence the bare word is vitest's
  // `describe` rather than a local helper of the same name.
  const noImport = "describe('X conformance', () => runConformanceSuite(fixtures));\n";
  assert.equal(isVitestTestFile(noImport), false);
});

test('CLI: a production source module exits non-zero instead of summarising zero of everything', () => {
  const root = makeSyntheticPackage({
    'suite-module.ts': [
      "import { describe } from 'vitest';",
      'export function runConformanceSuite(provider) {',
      "  describe('conformance', () => { describeManifestConformance(provider); });",
      '}',
      '',
    ].join('\n'),
  });
  try {
    const run = runCli([join(root, 'suite-module.ts')]);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /refusing a vacuous pass/);
    assert.doesNotMatch(run.stdout, /summary:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI: an `identifier < n` comparison is not reported as an unparsed call site', () => {
  // The comparison made `skipTypeArguments` return -1, which the caller read
  // as "found a call site but could not parse it" and the CLI turned into a
  // hard failure claiming the run under-reports. There is no call site here.
  const src = "if (it < 3) { doWork(); }\nit('real', () => { doWork(); });\n";
  assert.deepEqual(findUnparsedCallSites(src), []);
  const root = makeSyntheticPackage({ 'cmp.test.ts': src });
  try {
    const run = runCli([join(root, 'cmp.test.ts')]);
    assert.equal(run.status, 0);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /summary: 0 protected \(own call\/describe\), 0 config-protected, 0 config-unknown, 1 unprotected/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a `test.n < 4` comparison on a property is not read as a type-argument list either', () => {
  const src = "if (test.n < 4) { doWork(); }\nit('real', () => { doWork(); });\n";
  assert.deepEqual(findUnparsedCallSites(src), []);
  assert.deepEqual(auditSource(src).map((r) => r.name), ['real']);
});

test('JSX prose reading `test <b>(optional)</b>` does not invent a call site', () => {
  // `<b>` is a balanced pair of angle brackets followed by `(`, so an
  // angle-only scan stepped over it and read the `(optional)` that follows
  // as a `test(...)` argument list — a call site that does not exist,
  // reported as NO EXPLICIT TIMEOUT.
  const src = [
    "it('real', () => { doWork(); });",
    'const help = <p>test <b>(optional)</b></p>;',
  ].join('\n');
  assert.deepEqual(auditSource(src).map((r) => r.name), ['real']);
  assert.deepEqual(findUnparsedCallSites(src), []);
});

test('an object type inside a type-argument list parses instead of failing the run', () => {
  const src = "it.each<{ role: Role; ok: boolean }>([{ role: 'a', ok: true }])('role=$role', () => { doWork(); }, 22_000);";
  assert.deepEqual(findUnparsedCallSites(src), []);
  assert.deepEqual(protectedNames(src), ['role=$role']);
});

test('an object type with comma-separated members inside a type-argument list also parses', () => {
  const src = "it.each<{ role: Role, ok: boolean }>([{ role: 'a', ok: true }])('role=$role', () => { doWork(); }, 22_000);";
  assert.deepEqual(findUnparsedCallSites(src), []);
  assert.deepEqual(protectedNames(src), ['role=$role']);
});

test('a type-argument list on the call itself may hold an object type too', () => {
  const src = "test<{ ctx: string; n: number }>('typed', () => { doWork(); }, 60_000);";
  assert.deepEqual(findUnparsedCallSites(src), []);
  assert.deepEqual(protectedNames(src), ['typed']);
});

test('stripNoise keeps UTF-16 length exactly, astral-plane characters included', () => {
  // `Array.from` iterates CODE POINTS while every consumer of the result
  // indexes UTF-16 code units, so one emoji made the output one unit shorter
  // than the input and shifted every later offset — garbling reported names
  // and line numbers in seven real files.
  const src = "it('a \u{1F3E0} house', () => { doWork(); });\n";
  assert.equal(stripNoise(src).length, src.length);
});

test('a test name after an astral-plane character is reported cleanly, at the right line', () => {
  const src = [
    "it('a \u{1F3E0} house', () => { doWork(); });",
    "it('a Windows path survives', () => { doWork(); });",
    '',
  ].join('\n');
  const results = auditSource(src);
  assert.deepEqual(results.map((r) => r.name), ['a \u{1F3E0} house', 'a Windows path survives']);
  assert.deepEqual(results.map((r) => r.line), [1, 2]);
});
