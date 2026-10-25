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
import { wireCases, wireText } from './wire-cases.mjs';

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
// W1's old parse strategy rounds the decimal significand to binary64 FIRST,
// then scales it. Use the general arithmetic on raw numeric tokens, skipping
// quoted strings. This is a behavioral mutant, not an expected-value change.
function doubleRoundedParse(json) {
  return JSON.parse(json.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/gu, (token) => {
    if (token.startsWith('"')) return token;
    const [mantissa, scale = '0'] = token.split(/[eE]/u);
    const fraction = mantissa.split('.')[1]?.length ?? 0;
    const significand = Number(mantissa.replace('.', ''));
    const exponent = Number(scale) - fraction;
    return String(exponent < 0 ? significand / 10 ** -exponent : significand * 10 ** exponent);
  }));
}
const mutants = [
  { name: 'W1 exact numeric value', file: 'json.mjs',
    before: 'return JSON.parse(json);', after: `return (${doubleRoundedParse.toString()})(json);`,
    witness: ({ decode }) => {
      const item = wireCases.find((entry) => entry.name === 'ordinary_rounding');
      assert.ok(item, 'ordinary numeric witness discovered');
      const result = decode('Options', wireText(item)); // still accepted: only value drifts
      const bytes = Buffer.alloc(8); bytes.writeDoubleBE(result.chordToleranceMetres);
      assert.equal(bytes.toString('hex'), '3fbf9add3746f65e', 'W1 decoded exact value');
    },
    failure: (error) => error.code === 'ERR_ASSERTION' && error.operator === 'strictEqual'
      && error.actual === '3fbf9add3746f65f' && error.expected === '3fbf9add3746f65e' },
  ...['constructed', 'wire'].map((path) => ({
    name: `W2 cause/flag ${path}`, file: 'validate.mjs',
    before: "report.error.code !== 'ENUMERATION_FAILED' || !p.enumerationComplete", after: 'true',
    witness: ({ validate, decode }) => {
      const run = (item) => path === 'constructed' ? validate(item.root, item.input, item.binding)
        : decode(item.root, JSON.stringify(item.input), item.binding);
      assert.doesNotThrow(() => run(named('failed_enumeration')), 'false flag control');
      const item = named('enumeration_failed_claims_complete_without_successes');
      assert.equal(item.input.partition.geometry.length + item.input.partition.removed.length, 0);
      assert.throws(() => run(item), /Retained contract: enumeration failure flag/u, `W2 ${path} rejection`);
    },
  })),
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
    assert.throws(() => mutant.witness(broken), mutant.failure ?? ((error) => error.code === 'ERR_ASSERTION'
      && error.message.startsWith('Missing expected exception')), 'intended behavioral assertion must fail');
    mutant.witness(await load('restored', false));
  } finally { await rm(root, { recursive: true, force: true }); }
});
