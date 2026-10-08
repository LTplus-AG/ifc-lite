/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { INVARIANTS, INVARIANT_IDS, checkAnswer, checkRunBudget, proposalJson } from './invariants.mjs';

const finding = (citation, extra = {}) => ({ citation, data: { id: citation, severity: 'info' }, ...extra });
const evidence = { source: 'clash', totalRows: 5, includedRows: 3, evidence: { summary: { total: 5, bySeverity: { major: 1, info: 4 } },
  rows: [finding('E1'), finding('E2'), finding('E3', { rowProjectionTruncated: true })] } };
const ids = result => result.violations.map(violation => violation.id);
const groups = list => JSON.stringify({ version: 1, kind: 'clash.groups', groups: list });

test('every invariant states what it cannot see', () => {
  for (const entry of INVARIANTS) assert.ok(entry.limit.length > 20, `${entry.id} has no stated limit`);
  assert.equal(new Set(INVARIANT_IDS).size, INVARIANT_IDS.length);
});

test('citations-valid: an unknown row id is flagged, known ones are not', () => {
  assert.deepEqual(ids(checkAnswer({ text: 'See [E1] and [E9].', source: 'clash', evidence })), ['citations-valid']);
  assert.deepEqual(ids(checkAnswer({ text: 'See [E1] and [E2].', source: 'clash', evidence })), []);
});

test('findings-accounted: repeats across groups, truncated rows and over-counting are flagged; a partial grouping is fine', () => {
  const run = list => ids(checkAnswer({ text: groups(list), source: 'clash', evidence }));
  assert.deepEqual(run([{ name: 'A', citations: ['E1'] }, { name: 'B', citations: ['E2'] }]), []);
  assert.deepEqual(run([{ name: 'A', citations: ['E1'] }]), [], 'unmentioned findings stay unclassified');
  assert.ok(run([{ name: 'A', citations: ['E1'] }, { name: 'B', citations: ['E1'] }]).includes('findings-accounted'));
  assert.ok(run([{ name: 'A', citations: ['E3'] }]).includes('findings-accounted'), 'a row projected with truncation is not a complete finding');
  const result = checkAnswer({ text: groups([{ name: 'A', citations: ['E1', 'E2'] }]), source: 'clash', evidence });
  assert.deepEqual(result.facts.accounting, { total: 5, proposed: 2, unclassified: 3, omittedFromEvidence: 2 });
});

test('no-duplicate-topics: names compare case- and space-insensitively; identical membership is a duplicate', () => {
  const run = list => ids(checkAnswer({ text: groups(list), source: 'clash', evidence }));
  assert.ok(run([{ name: 'Walls  vs Slabs', citations: ['E1'] }, { name: 'walls vs slabs', citations: ['E2'] }]).includes('no-duplicate-topics'));
  assert.ok(run([{ name: 'A', citations: ['E1', 'E2'] }, { name: 'B', citations: ['E2', 'E1'] }]).includes('no-duplicate-topics'));
  assert.deepEqual(run([{ name: 'A', citations: ['E1'] }, { name: 'B', citations: ['E2'] }]), []);
});

test('count-claims-match-facts: a counted noun needs a number present in the evidence; the check is presence, not denominator', () => {
  const run = text => ids(checkAnswer({ text, source: 'clash', evidence }));
  assert.deepEqual(run('There are 5 clashes, 1 major finding.'), []);
  assert.deepEqual(run('There are 23 clashes in total.'), ['count-claims-match-facts']);
  assert.deepEqual(run('4 findings are info; 1 is major.'), []);
  // The documented limit: 3 exists in the evidence (includedRows), so a wrong denominator still passes and needs a human label.
  assert.deepEqual(run('There are 3 clashes in the run.'), []);
});

test('no-effect-claims: first-person effect phrases are flagged, hedged descriptions are not', () => {
  const run = text => ids(checkAnswer({ text, source: 'clash', evidence }));
  assert.deepEqual(run('I have created the issues.'), ['no-effect-claims']);
  assert.deepEqual(run("I've applied the fix."), ['no-effect-claims']);
  assert.deepEqual(run('I ran the check for you.'), ['no-effect-claims']);
  assert.deepEqual(run('You can create issues from [E1]; nothing has been created.'), []);
});

test('proposal-kind-allowed: the declared kind must be one the evidence source offers', () => {
  assert.deepEqual(ids(checkAnswer({ text: JSON.stringify({ version: 1, kind: 'flow.patch', operations: [] }), source: 'clash', evidence })), ['proposal-kind-allowed']);
  assert.deepEqual(ids(checkAnswer({ text: JSON.stringify({ version: 1, kind: 'flow.patch', operations: [] }), source: 'flow', evidence: { evidence: { rows: [] } } })), []);
});

test('budget-respected: only provider-reported usage above the ceiling is flagged; unreported usage is never estimated', () => {
  const run = usage => ids(checkAnswer({ text: 'ok [E1]', source: 'clash', evidence, usage, maxOutputTokens: 100 }));
  assert.deepEqual(run({ inputTokens: 5, outputTokens: 101 }), ['budget-respected']);
  assert.deepEqual(run({ inputTokens: 5, outputTokens: 100 }), []);
  assert.deepEqual(run(null), []);
});

test('proposalJson reads a fenced or bare typed answer and reports a parse failure instead of throwing', () => {
  assert.equal(proposalJson('```json\n{"kind":"flow.patch"}\n```').value.kind, 'flow.patch');
  assert.ok(proposalJson('{"kind":"flow.patch", broken').parseError);
  assert.equal(proposalJson('Plain prose, "kind": "x.y" inside text.'), null, 'prose never reaches the typed path');
});

test('checkRunBudget counts requests and only reported output tokens', () => {
  const receipts = [{ usageReported: true, outputTokens: 60 }, { usageReported: false }, { usageReported: true, outputTokens: 50 }];
  assert.deepEqual(checkRunBudget(receipts, { maxRequests: 3, maxOutputTokens: 110 }),
    { violations: [], requests: 3, reportedOutputTokens: 110, unreported: 1 });
  const over = checkRunBudget(receipts, { maxRequests: 2, maxOutputTokens: 100 });
  assert.equal(over.violations.length, 2);
});
