// SPDX-License-Identifier: MPL-2.0
// #7955 repair guard witnesses: green / predicate mutant red / restored green.
// Only temporary copies of private JS validators are changed. A failed import,
// syntax error or unrelated exception cannot count as a behavioral mutant kill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cases, options } from './cases.mjs';

const named = (name) => {
  const item = cases.find((entry) => entry.name === name);
  assert.ok(item, `independent witness ${name} discovered`);
  return item;
};
const rejectedCase = (name) => ({ validate, decode }) => {
  const { root, input, binding } = named(name);
  assert.throws(() => validate(root, input, binding), /Retained contract:/u, `constructed ${name}`);
  assert.throws(() => decode(root, JSON.stringify(input), binding), /Retained contract:/u, `wire ${name}`);
};
const mutants = [
  { name: 'R3 reason', file: 'validate.mjs',
    before: "demand(result.detail.reason === rule.reason, 'cause reason');",
    after: "demand(true, 'cause reason');", witness: rejectedCase('staged_removal_policy_unproven_wrong_reason') },
  { name: 'R3 context', file: 'validate.mjs',
    before: "demand(rule.contexts.some(([stage, requirement]) => stage === result.stage\n          && requirement === result.requirement), 'cause context');",
    after: "demand(true, 'cause context');", witness: rejectedCase('staged_removal_policy_unproven_wrong_stage') },
  { name: 'R4 geometry before enumeration', file: 'validate.mjs',
    before: 'p.geometry.length === 0 && p.removed.length === 0', after: 'p.removed.length === 0',
    witness: rejectedCase('failed_geometry_before_enumeration') },
  { name: 'R4 removal before enumeration', file: 'validate.mjs',
    before: 'p.geometry.length === 0 && p.removed.length === 0', after: 'p.geometry.length === 0',
    witness: rejectedCase('cancelled_removed_before_enumeration') },
  { name: 'R2 raw byte cap', file: 'json.mjs', before: ' || Buffer.byteLength(json) > maxBytes', after: '',
    witness: ({ decode }) => assert.throws(() => decode('Options', ' '.repeat(4194305) + JSON.stringify(options)), /Retained contract:/u) },
  { name: 'R2 raw depth cap', file: 'json.mjs', before: 'stack.length >= maxDepth', after: 'false',
    witness: ({ parseWire }) => assert.throws(() => parseWire('['.repeat(33) + '0' + ']'.repeat(33), 4194304, 32), /Retained contract:/u) },
  { name: 'R1 raw duplicate preservation', file: 'json.mjs', before: 'top.keys.has(key)', after: 'false',
    witness: ({ decode }) => assert.throws(() => decode('Options', JSON.stringify(options)
      .replace('"schemaVersion":1', '"schemaVersion":2,"\\u0073chemaVersion":1')), /Retained contract:/u) },
];
for (const mutant of mutants) test(`#7955 mutation ${mutant.name}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'a1s-guard-'));
  try {
    const sources = new Map(await Promise.all(['validate.mjs', 'json.mjs', 'schema.mjs']
      .map(async (name) => [name, await readFile(new URL(name, import.meta.url), 'utf8')])));
    const load = async (phase, changed) => {
      const directory = join(root, phase); await mkdir(directory);
      for (const [name, source] of sources) {
        await writeFile(join(directory, name), changed && name === mutant.file ? source.replace(mutant.before, mutant.after) : source);
      }
      const validator = await import(pathToFileURL(join(directory, 'validate.mjs')).href);
      const wire = await import(pathToFileURL(join(directory, 'json.mjs')).href);
      return { ...validator, ...wire };
    };
    mutant.witness(await load('baseline', false));
    const broken = await load('mutant', true); // loading errors fail, never qualify
    assert.deepEqual(broken.decode('Options', JSON.stringify(options)), options, 'valid control remains valid');
    assert.throws(() => mutant.witness(broken), (error) => error.code === 'ERR_ASSERTION'
      && error.message.startsWith('Missing expected exception'), 'intended rejection assertion must fail');
    mutant.witness(await load('restored', false));
  } finally { await rm(root, { recursive: true, force: true }); }
});
