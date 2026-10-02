/* SPDX-License-Identifier: MPL-2.0 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readEvalCache, readEvalContext } from './eval-cache.mjs';

function evidence(t, validation = { attempts: 1, reason: null }) {
  const dir = mkdtempSync(join(tmpdir(), 'eval-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = { headSha: 'a'.repeat(40), files: [{ path: 'a.ts', patch: '+x' }] };
  for (const [suffix, value] of Object.entries({ 'input.json': JSON.stringify(input), 'out.txt': 'model answer', 'validation.json': JSON.stringify(validation), 'out.txt.telemetry.jsonl': '{"model":"candidate"}\n' })) writeFileSync(join(dir, `case.${suffix}`), value);
  return { dir, input };
}

test('cache refuses another candidate or historical patch', (t) => {
  const { dir, input } = evidence(t);
  assert.throws(() => readEvalCache(dir, 'case', input, 'other'), /different model/);
  assert.throws(() => readEvalCache(dir, 'case', { ...input, headSha: 'b'.repeat(40) }, 'candidate'), /does not match/);
});

test('a failed corrective model call cannot be resumed as a completed review', (t) => {
  const { dir, input } = evidence(t, { attempts: 2, reason: 'RAW_UNPARSEABLE' });
  assert.equal(readEvalCache(dir, 'case', input, 'candidate'), null);
});

test('a completed model refusal is reusable, but an instrument failure is not', (t) => {
  const { dir, input } = evidence(t, { attempts: 1, reason: 'SCHEMA_INVALID' });
  assert.equal(readEvalCache(dir, 'case', input, 'candidate').attempts, 1);
  writeFileSync(join(dir, 'case.validation.json'), JSON.stringify({ attempts: 1, reason: 'INPUT_INVALID' }));
  assert.equal(readEvalCache(dir, 'case', input, 'candidate'), null);
});


test('changing reasoning cannot reuse model answers from another profile', (t) => {
  const { dir, input } = evidence(t);
  writeFileSync(join(dir, 'case.out.txt.telemetry.jsonl'), '{"model":"openai/gpt-6-luna"}\n');
  assert.throws(() => readEvalCache(dir, 'case', input, 'openai/gpt-6-luna', 'cheap-defaults'), /different reasoning profile/);
});

test('resume uses the recorded context tree and refuses missing or symbolic refs (#6706)', (t) => {
  const { dir } = evidence(t);
  assert.throws(() => readEvalContext(dir), /no pinned context/);
  writeFileSync(join(dir, 'eval-context.txt'), 'HEAD');
  assert.throws(() => readEvalContext(dir), /no pinned context/);
  const context = 'c'.repeat(40);
  writeFileSync(join(dir, 'eval-context.txt'), context + '\n');
  assert.equal(readEvalContext(dir), context);
});

test('a paid failure followed by successful regeneration is reusable without erasing receipts (#6706)', (t) => {
  const { dir, input } = evidence(t);
  const receipt = join(dir, 'case.out.txt.telemetry.jsonl');
  const calls = [{ model: 'candidate', answered: false }, { model: 'candidate', answered: true }];
  writeFileSync(receipt, calls.map((call) => JSON.stringify(call)).join('\n'));
  assert.equal(readEvalCache(dir, 'case', input, 'candidate').attempts, 1);
  writeFileSync(join(dir, 'case.validation.json'), JSON.stringify({ attempts: 2, reason: null }));
  assert.equal(readEvalCache(dir, 'case', input, 'candidate'), null);
  calls.push({ model: 'candidate', answered: true });
  writeFileSync(receipt, calls.map((call) => JSON.stringify(call)).join('\n'));
  assert.equal(readEvalCache(dir, 'case', input, 'candidate').attempts, 2);
  assert.equal(readFileSync(receipt, 'utf8').split('\n').length, 3);
});
