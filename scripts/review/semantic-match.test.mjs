/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { available, systemOne, ENDPOINT } from './lib/jev-client.mjs';
import { buildMatchRequest, semanticMatches, semanticMatcher, resolveMatchers, MATCH_THRESHOLD } from './lib/semantic-match.mjs';
import { matches, score } from './lib/eval-score.mjs';

const ENV = { TYPESAFE_API_KEY: 'test-key' };
const EXPECTED = { path: 'scripts/check-review-posted.mjs', what: 'headRepo !== repo compares case-sensitively and can be reached with a null repo', class: 'absence-reads-as-success' };
const F_SAME = { path: EXPECTED.path, line: 533, body: '`headRepo !== repo` can silently disable enforcement: repository names are case-insensitive and `--repo` is caller-supplied.', quote: 'if (headRepo !== repo) {' };
const F_OTHER = { path: EXPECTED.path, line: 600, body: 'The check is correct.', quote: 'return covered;' };
const F_ELSEWHERE = { path: 'scripts/other.mjs', line: 1, body: 'headRepo case-sensitively disables enforcement', quote: 'x' };

/** A fetch that answers every `same_i` with the probability the test dictates and records the request. */
function stubFetch(probabilities, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const answers = {};
    for (const key of Object.keys(calls.at(-1).body.questions)) answers[key] = { type: 'noul', noul: probabilities[key] ?? 0 };
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } }) };
  };
}

test('available() is the only gate: no key means no call, ever', async () => {
  assert.equal(available({}), false);
  assert.equal(available({ TYPESAFE_API_KEY: '  ' }), false);
  assert.equal(available(ENV), true);
  await assert.rejects(() => systemOne({ state: {}, questions: {}, env: {}, fetchImpl: () => { throw new Error('must not be called'); } }), /TYPESAFE_API_KEY/);
});

test('the request carries only the expected description and same-file findings, never the diff or PR body', () => {
  const { state, questions } = buildMatchRequest(EXPECTED, [F_SAME, F_OTHER]);
  assert.deepEqual(Object.keys(questions), ['same_0', 'same_1']);
  assert.equal(state.expected_defect.description, EXPECTED.what);
  assert.equal(state.candidate_findings.length, 2);
  assert.equal(state.candidate_findings[1].text, F_OTHER.body);
  assert.equal(JSON.stringify(state).includes('contextPack'), false);
  for (const q of Object.values(questions)) assert.equal(q.type, 'noul');
});

test('a same-file finding above the threshold is a hit that names the finding and its probability', async () => {
  const calls = [];
  const m = await semanticMatches(EXPECTED, [F_ELSEWHERE, F_OTHER, F_SAME], { env: ENV, fetchImpl: stubFetch({ same_0: 0.05, same_1: 0.93 }, calls) });
  assert.equal(m.hit, true);
  assert.equal(m.by, `${EXPECTED.path}:533 (P 0.93)`);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].body.model, 'jev-latest');
  // F_ELSEWHERE is on another path and was never sent: index 0 is F_OTHER.
  assert.equal(calls[0].body.state.candidate_findings[0].line, 600);
});

test('below the threshold is a miss that still reports the best probability; no same-file finding is a miss without a call', async () => {
  const miss = await semanticMatches(EXPECTED, [F_OTHER], { env: ENV, fetchImpl: stubFetch({ same_0: MATCH_THRESHOLD - 0.01 }) });
  assert.deepEqual(miss, { hit: false, by: null, score: MATCH_THRESHOLD - 0.01 });
  const none = await semanticMatches(EXPECTED, [F_ELSEWHERE], { env: ENV, fetchImpl: () => { throw new Error('must not be called'); } });
  assert.deepEqual(none, { hit: false, by: null, score: null });
});

test('the stem rule and the semantic rule disagree on exactly the false credit the bench measured', async () => {
  // "The check is correct" shares no defect with EXPECTED, yet a body that echoes two stems is a stem hit.
  const echo = { path: EXPECTED.path, line: 600, body: 'headRepo compares case-sensitively; the check is correct.', quote: 'x' };
  assert.equal(matches(EXPECTED, [echo]).hit, true);
  const m = await semanticMatches(EXPECTED, [echo], { env: ENV, fetchImpl: stubFetch({ same_0: 0.04 }) });
  assert.equal(m.hit, false);
});

test('semanticMatcher resolves every pair up front and score() consumes it by position; a failed request falls back to the stem rule', async () => {
  const cases = [
    { pr: 1, body: null, expected: [EXPECTED], verdict: 'findings', findings: [F_SAME], notApplicable: [] },
    { pr: 2, body: null, expected: [EXPECTED], verdict: 'findings', findings: [F_OTHER], notApplicable: [] },
  ];
  // Fails on every attempt for the PR #2 request (retries included), so the pair falls back.
  const flaky = async (url, init) => {
    if (JSON.parse(init.body).state.candidate_findings[0].line === F_OTHER.line) throw new Error('boom');
    return stubFetch({ same_0: 0.9 })(url, init);
  };
  const logs = [];
  const sem = await semanticMatcher(cases, { env: ENV, fetchImpl: flaky, fallback: matches, log: (m) => logs.push(m) });
  assert.equal(sem.calls, 1);
  assert.equal(sem.failures, 1);
  assert.match(logs[0], /PR #2 .*stem matcher/);
  const s = score(cases, { matcher: sem.matcher });
  // case 1: semantic hit at 0.9; case 2: stem fallback on "The check is correct." -> miss.
  assert.equal(s.hits, 1);
  assert.equal(s.total, 2);
  assert.match(s.lines.join('\n'), /via scripts\/check-review-posted\.mjs:533 \(P 0\.90\)/);
  // The default matcher is untouched: the same cases score the same as before this change.
  assert.equal(score(cases).hits, matches(EXPECTED, [F_SAME]).hit ? 1 : 0);
});

test('systemOne retries a 429 and surfaces a 4xx without retrying', async () => {
  let n = 0;
  const seq = [{ status: 429, body: 'slow down' }, { status: 200, body: JSON.stringify({ answers: { q: { type: 'noul', noul: 0.5 } } }) }];
  const fetchImpl = async () => { const r = seq[n++]; return { ok: r.status === 200, status: r.status, text: async () => r.body }; };
  const res = await systemOne({ state: {}, questions: { q: { type: 'noul', instructions: '?' } }, env: ENV, fetchImpl });
  assert.equal(res.answers.q.noul, 0.5);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(() => systemOne({ state: {}, questions: {}, env: ENV, fetchImpl: async () => { m += 1; return { ok: false, status: 422, text: async () => 'bad question' }; } }), /HTTP 422/);
  assert.equal(m, 1);
});

test('resolveMatchers hands back the stem rule without a key, and offset-aware semantic matchers with one', async () => {
  const validated = [{ pr: 1, body: null, expected: [EXPECTED], verdict: 'findings', findings: [F_OTHER], notApplicable: [] }];
  const posted = [{ pr: 1, body: null, expected: [EXPECTED], verdict: 'findings', findings: [F_SAME], notApplicable: [] }];
  const off = await resolveMatchers(validated, posted, { env: {}, fallback: matches, fetchImpl: () => { throw new Error('must not be called'); } });
  assert.equal(off.semantic, false);
  assert.equal(off.forValidated, matches);
  assert.match(off.note, /stem matcher/);
  // Validated first, posted second: the posted matcher must look up index 1, not 0.
  const on = await resolveMatchers(validated, posted, { env: ENV, fallback: matches, fetchImpl: stubFetch({ same_0: 0.9 }) });
  assert.equal(on.semantic, true);
  assert.match(on.note, /2 TypeSafe call/);
  assert.equal(score(validated, { matcher: on.forValidated }).hits, 1);
  assert.equal(score(posted, { matcher: on.forPosted }).hits, 1);
  assert.match(score(posted, { matcher: on.forPosted }).lines.join('\n'), /a\.ts|check-review-posted\.mjs:533 \(P 0\.90\)/);
});
