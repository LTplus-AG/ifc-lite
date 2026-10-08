/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { typedReport } from '@/test/ai-report-fixture';
import { parseCapturedEvidence, type CapturedEvidence } from './captured-rows';
import { checkClaim, checkProposedClaims, editClaim, splitReportAnswer } from './report-claims';

const captured: CapturedEvidence = {
  summary: { totalCount: 3, units: { distance: 'm' } },
  rows: new Map<string, unknown>([['E1', { id: 'c0', distance: -0.02, status: 'hard' }], ['E2', { id: 'c1', distance: -0.035, status: 'soft' }]]),
};

test('typed claims are split from the prose; a declared but broken block is refused, never ignored (#6918)', () => {
  const answer = typedReport('## Findings\nTwo hard clashes [E1].', [{ text: 'E1 overlaps by 20 mm.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }] }], 'de-CH');
  const { prose, envelope } = splitReportAnswer(answer);
  assert.equal(prose, '## Findings\nTwo hard clashes [E1].');
  assert.equal(envelope?.language, 'de-CH');
  assert.deepEqual(envelope?.claims[0].citations, ['E1'], 'fact citations are claim citations');
  const bare = JSON.stringify({ version: 1, kind: 'report.claims', claims: [{ text: 'Only claims' }] });
  assert.equal(splitReportAnswer(bare).prose, '');
  assert.equal(splitReportAnswer('Plain prose [E1].').envelope, null);
  assert.throws(() => splitReportAnswer('Text {"kind":"report.claims", "claims": [ unterminated'), /one complete JSON block/);
  assert.throws(() => splitReportAnswer('```json\n{"version":1,"kind":"report.claims","claims":[{"text":"x"},]}\n```'), /not valid JSON/);
  assert.throws(() => splitReportAnswer(typedReport('', [{ text: 'x', citations: ['row 1'] }])), /captured row citations/);
  assert.throws(() => splitReportAnswer(typedReport('', [{ text: 'x', facts: [{ citation: 'E1', field: 'distance', value: Number.NaN }] }])), /single value/);
  assert.throws(() => splitReportAnswer(typedReport('', Array.from({ length: 31 }, () => ({ text: 'x' })))), /at most 30 claims/);
});

test('each claim is supported, unverifiable or contradicted by its cited native values', () => {
  const { envelope } = splitReportAnswer(typedReport('', [
    { text: 'E1 is a 20 mm hard clash.', facts: [{ citation: 'E1', field: 'distance', value: -20, unit: 'mm' }, { citation: 'E1', field: 'status', value: 'hard' }] },
    { text: 'Three findings in total.', facts: [{ citation: 'summary', field: 'totalCount', value: 3 }] },
    { text: 'E2 is critical.', facts: [{ citation: 'E2', field: 'severity', value: 'critical' }] },
    { text: 'Coordination should start with E1.', citations: ['E1'] },
    { text: 'E2 overlaps by 2 cm.', facts: [{ citation: 'E2', field: 'distance', value: -2, unit: 'cm' }] },
    { text: 'E9 is resolved.', citations: ['E9'] },
  ]));
  const checked = checkProposedClaims(envelope!.claims, captured);
  assert.deepEqual(checked.map(claim => [claim.id, claim.status]), [
    ['C1', 'supported'], ['C2', 'supported'], ['C3', 'unverifiable'], ['C4', 'unverifiable'], ['C5', 'contradicted'], ['C6', 'contradicted']]);
  assert.match(checked[2].results[0].check.kind === 'unverifiable' ? checked[2].results[0].check.reason : '', /not present/);
  assert.deepEqual(checked[5].unknownCitations, ['E9']);
});

test('a reviewer edit drops contradicted facts and unknown citations and is re-checked', () => {
  const { envelope } = splitReportAnswer(typedReport('', [{ text: 'E2 overlaps by 2 cm and is soft.', citations: ['E9'],
    facts: [{ citation: 'E2', field: 'distance', value: -2, unit: 'cm' }, { citation: 'E2', field: 'status', value: 'soft' }] }]));
  const [claim] = checkProposedClaims(envelope!.claims, captured);
  assert.equal(claim.status, 'contradicted');
  const edited = editClaim(claim, '  E2 is a soft clash.  ', captured);
  assert.equal(edited.text, 'E2 is a soft clash.');
  assert.equal(edited.edited, true);
  assert.deepEqual(edited.facts.map(fact => fact.field), ['status']);
  assert.deepEqual(edited.citations, ['E2']);
  assert.equal(edited.status, 'supported');
  assert.throws(() => editClaim(claim, '   ', captured), /statement text/);
});

// Review of #6972: a row named only in the claim text is still a citation, so it is checked and recorded.
test('E-numbers written in the claim text are citations; unknown ones contradict the claim', () => {
  const { envelope } = splitReportAnswer(typedReport('', [
    { text: 'E2 is soft, unlike E1.', facts: [{ citation: 'E2', field: 'status', value: 'soft' }] },
    { text: 'E9 is resolved.' },
  ]));
  assert.deepEqual(envelope!.claims.map(claim => claim.citations), [['E2', 'E1'], ['E9']]);
  const [soft, resolved] = checkProposedClaims(envelope!.claims, captured);
  assert.equal(soft.status, 'supported');
  assert.equal(resolved.status, 'contradicted');
  assert.deepEqual(resolved.unknownCitations, ['E9']);
  const edited = editClaim(soft, 'E2 is soft, like E7.', captured);
  assert.deepEqual(edited.citations, ['E2', 'E1', 'E7'], 'a reviewer edit is scanned too');
  assert.deepEqual(edited.unknownCitations, ['E7']);
  assert.equal(edited.status, 'contradicted');
  assert.throws(() => splitReportAnswer(typedReport('', [{ text: 'E0 is the first row.' }])), /not a captured row citation/);
});

// Review of #6973: a row a sampled capture does not include may still exist, so it cannot contradict.
test('a cited row outside a sampled capture leaves the claim unverifiable, a gone row contradicts it', () => {
  const claim = { id: 'C1', text: 'E1 is hard.', citations: ['E1'], facts: [{ citation: 'E1', field: 'status', value: 'hard' }], edited: false };
  const gone = () => null;
  assert.equal(checkClaim(claim, captured, { resolve: gone }).status, 'contradicted');
  const sampled = checkClaim(claim, captured, { resolve: gone, partial: true });
  assert.equal(sampled.status, 'unverifiable');
  assert.deepEqual(sampled.unknownCitations, []);
  assert.match(sampled.results[0].check.kind === 'unverifiable' ? sampled.results[0].check.reason : '', /outside the captured sample/);
  const listedOnly = checkClaim({ ...claim, citations: ['E1', 'E2'] }, captured, { resolve: c => c === 'E2' ? null : c, partial: true });
  assert.equal(listedOnly.status, 'unverifiable', 'an unsampled listed row withholds support');
});

test('strict evidence parsing refuses an oversized payload before parsing it', () => {
  assert.throws(() => parseCapturedEvidence(' '.repeat(200_001)), /too large/);
  assert.equal(parseCapturedEvidence(JSON.stringify({ evidence: { summary: null, rows: [{ citation: 'E1', data: 1 }] } })).rows.get('E1'), 1);
});
