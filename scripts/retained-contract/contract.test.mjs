// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases, options, complete, incomplete, binding, inspection } from './cases.mjs';
import { validate, decode, counts } from './validate.mjs';
import * as projection from './generated/contract.ts';

// Same independently expected data corpus is compiled into both Rust consumers.
for (const item of cases) test(`#7955 ${item.name}`, () => {
  const parse = projection[`parse${item.root}`];
  assert.equal(typeof parse, 'function');
  if (item.valid) {
    const result = parse(item.input, item.binding);
    assert.deepEqual(result, item.input);
    assert.ok(Object.isFrozen(result));
    assert.deepEqual(decode(item.root, JSON.stringify(item.input), item.binding), result);
  } else {
    assert.throws(() => parse(item.input, item.binding), /Retained contract:/u);
    assert.throws(() => decode(item.root, JSON.stringify(item.input), item.binding), /Retained contract:/u);
  }
});

test('#7955 option snapshot survives mutation of caller input', () => {
  const input = structuredClone(options);
  const frozen = projection.parseOptions(input);
  input.chordToleranceMetres = 10;
  assert.equal(frozen.chordToleranceMetres, 0.0001);
  assert.throws(() => { frozen.maxWork = '1'; }, TypeError);
  const reportInput = structuredClone(inspection);
  const report = projection.parseInspectionReport(reportInput, binding);
  reportInput.identity.options.deadlineMs = '1';
  assert.equal(report.identity.options.deadlineMs, '30000');
  assert.throws(() => { report.unchecked.pop(); }, TypeError);
});
test('#7955 non-JSON values fail before runtime work', () => {
  for (const value of [NaN, Infinity, -Infinity, -0, 0, undefined, null, 1n]) {
    assert.throws(() => validate('Options', { ...options, chordToleranceMetres: value }));
  }
  const getter = Object.defineProperty({ ...options }, 'maxWork', { get() { throw new Error('getter executed'); } });
  assert.throws(() => validate('Options', getter), /Retained contract:/u);
  assert.throws(() => validate('Options', { ...options, [Symbol('hidden')]: true }));
  assert.throws(() => validate('Options', Object.create(options)));
  const sparse = structuredClone(complete); delete sparse.partition.geometry[0];
  assert.throws(() => validate('ModelReport', sparse, binding));
  assert.throws(() => decode('Options', ' '.repeat(4194305) + JSON.stringify(options)));
  assert.throws(() => validate('Unknown', options));
});
test('#7955 counts derive from the validated partition, never caller totals', () => {
  assert.deepEqual(counts(complete, binding), { geometry: 2, removed: 0, refused: 0, nonGeometric: 1 });
  assert.deepEqual(counts(incomplete, binding), { geometry: 1, removed: 0, refused: 1, nonGeometric: 1 });
  assert.throws(() => counts({ ...complete, counts: { geometry: 3 } }, binding));
  assert.throws(() => validate('ModelReport', complete));
  assert.throws(() => counts(inspection, binding));
});
test('#7955 R4 incomplete enumeration settles known entries without successful counts', () => {
  for (const name of ['failed_enumeration', 'cancelled_partial_enumeration']) {
    const item = cases.find((entry) => entry.name === name);
    assert.deepEqual(counts(item.input, item.binding), { geometry: 0, removed: 0, refused: 2, nonGeometric: 1 });
  }
  for (const status of ['failed', 'cancelled']) for (const outcome of ['geometry', 'removed']) {
    const item = cases.find((entry) => entry.name === `${status}_after_enumeration_with_${outcome}`);
    assert.deepEqual(counts(item.input, item.binding), {
      geometry: outcome === 'geometry' ? 1 : 0, removed: outcome === 'removed' ? 1 : 0, refused: 1, nonGeometric: 1,
    });
  }
});
test('#7955 wire preflight rejects duplicate escaped keys and excessive nesting', () => {
  const valid = JSON.stringify(options);
  const duplicate = valid.replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1');
  const escaped = valid.replace('"schemaVersion":1', '"schemaVersion":2,"\\u0073chemaVersion":1');
  for (const json of [duplicate, escaped, '['.repeat(33) + '0' + ']'.repeat(33), '{"x":"private-path', 'null{}']) {
    assert.throws(() => decode('Options', json), /^Error: Retained contract: invalid JSON envelope$/u);
  }
  // JSON numeric spelling does not create a second version semantics in Rust.
  assert.deepEqual(decode('Options', valid.replace('"schemaVersion":1', '"schemaVersion":1.0')), options);
  assert.deepEqual(decode('Options', ` \n${valid}\t`), options);
});
