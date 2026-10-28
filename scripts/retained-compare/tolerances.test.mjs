// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTolerances } from './tolerances.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tolerances-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tolerances.json'), '{"base":{"absolute":0.001},"zero":0}');
  return root;
}

test('#7955 loads a frozen base and sorted slice fragments, preserving every value', (t) => {
  const root = fixture(t);
  assert.deepEqual(loadTolerances(root), { base: { absolute: 0.001 }, zero: 0 });
  mkdirSync(join(root, 'tolerances.d'));
  writeFileSync(join(root, 'tolerances.d/b.json'), '{"nullable":null,"flag":false}');
  writeFileSync(join(root, 'tolerances.d/a.json'), '{"__proto__":{"absolute":1e-9}}');
  writeFileSync(join(root, 'tolerances.d/README.md'), 'ignored');
  const merged = loadTolerances(root);
  assert.deepEqual(Object.keys(merged), ['base', 'zero', '__proto__', 'nullable', 'flag']);
  assert.equal(merged.__proto__.absolute, 1e-9);
  assert.equal(merged.nullable, null);
  assert.equal(merged.flag, false);
  assert.equal(merged.base.absolute, 0.001);
});

test('#7955 duplicates across base/fragments and between slices name both owners', (t) => {
  const root = fixture(t); mkdirSync(join(root, 'tolerances.d'));
  writeFileSync(join(root, 'tolerances.d/a.json'), '{"fresh":1}');
  for (const [value, first, key] of [
    ['{"base":{"relative":1}}', 'tolerances.json', 'base'],
    ['{"zero":0}', 'tolerances.json', 'zero'],
    ['{"fresh":1}', 'a.json', 'fresh'],
  ]) {
    writeFileSync(join(root, 'tolerances.d/b.json'), value);
    assert.throws(() => loadTolerances(root), (error) => [first, 'b.json', key, 'Duplicate tolerance'].every((part) => error.message.includes(part)));
  }
});

test('#7955 malformed and non-object documents fail with their path', (t) => {
  const root = fixture(t);
  for (const value of ['{', 'null', '[]', '1']) {
    writeFileSync(join(root, 'tolerances.json'), value);
    assert.throws(() => loadTolerances(root), /tolerances.json/);
  }
});
