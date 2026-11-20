/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Tests for the operation-refusal gate (#10871), run against synthetic trees in a temp directory so a change to the
 * viewer can never make them vacuously green.
 *
 * Run: `node --test scripts/check-operation-refusals.test.mjs`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OPERATIONS_DIR, runCheck } from './check-operation-refusals.mjs';

function tree(files) {
  const base = mkdtempSync(join(tmpdir(), 'operation-refusals-'));
  for (const [rel, body] of Object.entries(files)) {
    const path = join(base, OPERATIONS_DIR, rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body);
  }
  return base;
}
function check(files) {
  const base = tree(files);
  try { return runCheck(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('a plain throw in an operation is a violation, with its line', () => {
  const result = check({ 'zones.ts': "const a = 1;\nif (!a) throw new Error('Unknown zone.');\n" });
  assert.deepEqual(result.violations, [`${OPERATIONS_DIR}/zones.ts:2`]);
});

test('Error(), TypeError, RangeError, SyntaxError and reject(new Error()) are violations too', () => {
  const result = check({ 'a.ts': "throw Error('x');\nthrow new TypeError('y');\nthrow new RangeError('z');\nthrow new SyntaxError('s');\nreturn new Promise((_, reject) => reject(new Error('r')));\n" });
  assert.equal(result.violations.length, 5);
});

test('an Error built first and thrown later, or a built-in subclass, is a violation', () => {
  const result = check({ 'b.ts': "const err = new Error('Unknown zone.');\nthrow err;\nthrow Object.assign(new URIError('u'), {});\nthrow new AggregateError([], 'a');\nreturn Promise.reject(Error('r'));\nthrow ReferenceError('x');\n" });
  assert.equal(result.violations.length, 5);
  // A member call or a longer class name is not a plain Error.
  assert.deepEqual(check({ 'c.ts': "throw factory.Error('x');\nthrow new ToolExecutionError({ code, message });\nif (isError(value)) return;\n" }).violations, []);
});

test('the refusal helpers, rethrows and ToolExecutionError pass', () => {
  const result = check({ 'ok.ts': "throw invalidInput('unknown-target', 'Unknown zone.');\nthrow error;\nthrow new ToolExecutionError({ code, message });\n" });
  assert.deepEqual(result.violations, []); assert.equal(result.files, 1);
});

test('comments, strings, tests and generated contracts are not scanned', () => {
  const result = check({
    'doc.ts': "// throw new Error('in a comment')\n/* throw new Error('block') */\nconst s = \"throw new Error('in a string')\";\nconst t = `throw new Error($" + "{'x'})`;\n",
    'doc.test.ts': "throw new Error('a test may throw');\n",
    'generated/contracts.ts': "throw new Error('generated');\n",
  });
  assert.deepEqual(result.violations, []); assert.equal(result.files, 1);
});

test('a quote in a regex literal does not hide the code after it', () => {
  const result = check({ 'r.ts': "const q = /'/g, d = /[\"/]/;\nif (!q) throw new Error('after a regex');\nconst ratio = a / b / c; throw new Error('after division');\nconst inside = /Error\\(/;\nlet n = a++ / 2, m = b-- / 2; throw new Error('after postfix');\nconst r = obj.return / 2; throw new Error('after a member named return');\nif (ok) /'/.test(s) && f(); throw new Error('after a regex after if');\n" });
  assert.deepEqual(result.violations, [2, 3, 5, 6, 7].map(line => `${OPERATIONS_DIR}/r.ts:${line}`));
});

test('code inside a template interpolation is scanned', () => {
  const result = check({ 't.ts': "const m = `a $" + "{(() => { throw new Error('in an interpolation'); })()} b $" + "{'Error('}`;\nthrow new Error('after the template');\n" });
  assert.deepEqual(result.violations, [`${OPERATIONS_DIR}/t.ts:1`, `${OPERATIONS_DIR}/t.ts:2`]);
});

test('nested operation directories are scanned', () => {
  assert.equal(check({ 'family/deep.ts': "throw new Error('nested');\n" }).violations.length, 1);
});

test('a missing or empty operations directory fails loudly instead of passing vacuously', () => {
  const base = mkdtempSync(join(tmpdir(), 'operation-refusals-empty-'));
  try { assert.throws(() => runCheck(base), /does not exist/); } finally { rmSync(base, { recursive: true, force: true }); }
  assert.throws(() => check({ 'notes.md': 'no code here' }), /no operation files found/);
});

test('the CLI passes on the real operations tree', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), 'check-operation-refusals.mjs');
  const real = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr); assert.match(real.stdout, /no plain Error throws/);
});
