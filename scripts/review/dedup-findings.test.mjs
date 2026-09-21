/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDedupRequest, mergeDuplicates, scorePairs, main, DUPLICATE_THRESHOLD } from './dedup-findings.mjs';

const ENV = { TYPESAFE_API_KEY: 'test-key' };
const F = [
  { path: 'a.ts', line: 10, severity: 'high', body: 'getYaw returns the mutable object; a caller mutating .angle desyncs change detection.', quote: 'return yaw;' },
  { path: 'a.ts', line: 10, severity: 'medium', body: 'Returns internal state by reference.', quote: 'return yaw;' },
  { path: 'b.ts', line: 40, severity: 'high', body: 'setYaw stores the caller object; later mutation desyncs yawEqual.', quote: 'this.yaw = yaw;', sibling: { path: 'a.ts', line: 10 } },
  { path: 'c.ts', line: 5, severity: 'low', body: 'Unrelated: off-by-one in the day walk cap.', quote: 'i <= MAX' },
];

function stubFetch(probabilities, calls = []) {
  return async (url, init) => {
    calls.push(JSON.parse(init.body));
    const answers = {};
    for (const key of Object.keys(calls.at(-1).questions)) answers[key] = { type: 'noul', noul: probabilities[key] ?? 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
  };
}

test('one request, every finding once, one yes/no per unordered pair', () => {
  const { state, questions, pairs } = buildDedupRequest(F);
  assert.equal(state.findings.length, 4);
  assert.equal(pairs.length, 6);
  assert.deepEqual(Object.keys(questions), ['dup_0_1', 'dup_0_2', 'dup_0_3', 'dup_1_2', 'dup_1_3', 'dup_2_3']);
  assert.equal(state.findings[2].cross_file_evidence, 'a.ts:10');
  assert.equal(JSON.stringify(state).includes('contextPack'), false);
});

test('a group above the threshold keeps one survivor: verified sibling first, then the more specific text', () => {
  const scores = [{ a: 0, b: 1, p: 0.95 }, { a: 0, b: 2, p: 0.88 }, { a: 1, b: 2, p: 0.6 }, { a: 0, b: 3, p: 0.02 }, { a: 1, b: 3, p: 0.01 }, { a: 2, b: 3, p: 0.03 }];
  const { kept, dropped } = mergeDuplicates(F, scores);
  // 0-1-2 are one group (0~1 and 0~2 above 0.7; 1~2 joins through 0). Survivor is 2: it has a sibling.
  assert.deepEqual(kept.map((f) => `${f.path}:${f.line}`), ['b.ts:40', 'c.ts:5']);
  assert.deepEqual(dropped.map((d) => [d.index, d.duplicateOf]), [[0, 2], [1, 2]]);
  assert.equal(dropped[0].probability, 0.95);
  // Without the sibling, the longest body wins; ties go to the earliest index.
  const noSib = F.map((f) => ({ ...f, sibling: undefined }));
  assert.equal(mergeDuplicates(noSib, scores).kept[0].line, 10);
  assert.equal(mergeDuplicates(noSib, scores).kept[0].body, F[0].body);
});

test('below the threshold nothing merges, and the threshold is the documented one', () => {
  const { kept, dropped } = mergeDuplicates(F, [{ a: 0, b: 1, p: DUPLICATE_THRESHOLD - 0.01 }]);
  assert.equal(kept.length, 4);
  assert.equal(dropped.length, 0);
  assert.equal(DUPLICATE_THRESHOLD, 0.7);
});

test('scorePairs refuses a response with a missing answer rather than guessing', async () => {
  const bad = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ answers: { dup_0_1: { type: 'noul', noul: 0.9 } } }) });
  await assert.rejects(() => scorePairs(F, { env: ENV, fetchImpl: bad }), /dup_0_2 missing/);
  assert.deepEqual(await scorePairs([F[0]], { env: ENV, fetchImpl: () => { throw new Error('must not be called'); } }), []);
});

function harness(doc, env, fetchImpl) {
  const files = { 'in.json': JSON.stringify(doc) };
  const logs = [];
  const io = { readFile: (p) => files[p], writeFile: (p, t) => { files[p] = t; }, log: (m) => logs.push(m), env, fetchImpl };
  return { files, logs, run: () => main(['--findings', 'in.json', '--out', 'out.json'], io) };
}

test('main merges and records what it dropped, keeping the rest of the document', async () => {
  const doc = { verdict: 'findings', classPass: true, findings: F };
  const h = harness(doc, ENV, stubFetch({ dup_0_1: 0.96 }));
  await h.run();
  const out = JSON.parse(h.files['out.json']);
  assert.equal(out.verdict, 'findings');
  assert.equal(out.classPass, true);
  assert.equal(out.findings.length, 3);
  assert.equal(out.dedup.ran, true);
  assert.deepEqual(out.dedup.dropped.map((d) => d.index), [1]);
  assert.match(h.logs.join('\n'), /DEDUP MERGED a\.ts:10 into finding 0 \(P 0\.96\)/);
});

test('main fails soft: no key, a network error, or one finding all pass the input through unchanged and say why', async () => {
  const doc = { verdict: 'findings', findings: F };
  const noKey = harness(doc, {}, () => { throw new Error('must not be called'); });
  await noKey.run();
  assert.equal(JSON.parse(noKey.files['out.json']).findings.length, 4);
  assert.equal(JSON.parse(noKey.files['out.json']).dedup.ran, false);
  assert.match(noKey.logs[0], /TYPESAFE_API_KEY not set/);

  const down = harness(doc, ENV, async () => { throw new Error('ECONNRESET'); });
  await down.run();
  assert.equal(JSON.parse(down.files['out.json']).findings.length, 4);
  assert.match(down.logs.join('\n'), /dedup unavailable: ECONNRESET/);

  const one = harness({ findings: [F[0]] }, ENV, () => { throw new Error('must not be called'); });
  await one.run();
  assert.match(one.logs[0], /fewer than two findings/);
});

test('main needs both paths', async () => {
  await assert.rejects(() => main(['--findings', 'x'], { readFile: () => '{}', writeFile: () => {}, log: () => {}, env: ENV }), /usage/);
});
