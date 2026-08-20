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
import { auditSource, classifyExplicitTimeout, hasExplicitTimeout, stripNoise } from './vitest-timeout-audit.mjs';

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
