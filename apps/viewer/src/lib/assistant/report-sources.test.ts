/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { typedReport } from '@/test/ai-report-fixture';
import { validateDocumentSpec } from '../document/types';
import { cancelAssistant, replaceEvidence, useAssistant } from './conversation';
import { captureEvidence } from './evidence';
import { contradictedClaims, prepareReportDraft, reviseReportClaim, saveReportDraft } from './report-draft';
import { ASSISTANT_SOURCES, isFlowSource, isReportSource } from './sources';

const initial = useViewerStore.getState();
afterEach(() => { cancelAssistant(); useViewerStore.setState(initial, true); });

/** Deterministic LCG so every source gets different but reproducible native values. */
function seeded(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}

/**
 * The common adapter row envelope (`kind`, identity, `unit`) over a seeded value. Invariant: the
 * report path reads only this envelope and the source id, so any registered source drafts the same way.
 */
function adapterPayload(source: string, capturedAt: string, seed: number): { payload: string; rows: number; values: number[] } {
  const random = seeded(seed);
  const values = Array.from({ length: 5 }, () => Math.round(random() * 10_000) / 1000);
  const rows = values.map((value, index) => ({ citation: `E${index + 1}`,
    data: { kind: 'measurement', modelId: 'model-a', globalId: `${source}-${index}`, unit: 'm', value } }));
  return { values, rows: rows.length, payload: JSON.stringify({ source, capturedAt, models: [], totalModels: 0,
    sourceAvailability: 'available', totalRows: 7, includedRows: rows.length, sampled: true, projectionTruncated: false,
    evidence: { summary: { total: 7, units: { total: 'rows' } }, rows } }) };
}

// #6918: report drafts from every registered evidence adapter, through one generic path.
test('every registered analysis source drafts a native report with checked claims', async () => {
  const sources = ASSISTANT_SOURCES.filter(isReportSource);
  assert.ok(sources.length >= 4 && !sources.some(isFlowSource));
  for (const [index, source] of sources.entries()) {
    const snapshot = captureEvidence(source);
    const { payload, rows, values } = adapterPayload(source, snapshot.capturedAt, 6918 + index);
    replaceEvidence({ ...snapshot, payload, totalRows: 7, includedRows: rows });
    const millimetres = Math.round(values[1] * 1000);
    useAssistant.setState({ messages: [{ role: 'user', content: 'Draft a report' }, { role: 'assistant', model: 'actual-provider',
      content: typedReport(`## ${source}\nObserved values [E2].`, [
        { text: `E2 measures ${millimetres} mm.`, facts: [{ citation: 'E2', field: 'value', value: millimetres, unit: 'mm' }] },
        { text: 'Seven native rows exist.', facts: [{ citation: 'summary', field: 'total', value: 7 }] },
        { text: 'E3 is wrong on purpose.', facts: [{ citation: 'E3', field: 'value', value: values[2] + 1, unit: 'm' }] },
        { text: 'E4 is in a plant room.', citations: ['E4'] },
        // E6 is a native row outside the 5-of-7 sample: unverifiable, never contradicted.
        { text: 'E6 measures 1 m.', facts: [{ citation: 'E6', field: 'value', value: 1, unit: 'm' }] },
      ]) }] });
    const draft = prepareReportDraft(`${source} report`, 'fr');
    assert.deepEqual(draft.claims.map(claim => claim.status), ['supported', 'supported', 'contradicted', 'unverifiable', 'unverifiable'], source);
    assert.deepEqual(validateDocumentSpec(JSON.parse(draft.documentJson)), [], source);
    assert.equal(draft.document.aiReport?.evidence.source, source);
    assert.equal(draft.document.aiReport?.language, 'fr');
    assert.equal(draft.document.aiReport?.citedRows.E2, `globalId=${source}-1|modelId=model-a`, 'cited rows keep their native identity');
    const text = draft.document.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n');
    // #7302: this draft explicitly requests French; provider prose and native facts stay verbatim.
    assert.match(text, new RegExp(`Source : ${source} ·`));
    assert.match(text, /Données incluses : 5 sur 7 lignes natives\.\nCeci est un échantillon/);
    const revised = reviseReportClaim(draft, 'C3', 'remove');
    assert.deepEqual(revised.claims.map(claim => claim.id), ['C1', 'C2', 'C4', 'C5'], 'removal keeps the other claim ids');
    assert.equal(reviseReportClaim(revised, 'C5', { text: 'E6 is a long pipe [E6].' }).claims.at(-1)?.status, 'unverifiable',
      'an edited claim is re-checked as a sample too');
    assert.deepEqual(contradictedClaims(revised), []);
    assert.equal(revised.document.id, draft.document.id, 'a reviewer change recomposes the same document');
    assert.equal(revised.document.aiReport?.citedRows.E3, undefined, 'a removed claim no longer pins its row');
    await assert.rejects(saveReportDraft(draft, draft.documentJson), /contradicted by the captured evidence must be edited or removed: C3/,
      'the library refuses what the review UI disables');
  }
});

test('Flow graph evidence is not an analysis result and cannot become a report', () => {
  assert.equal(isReportSource('flow'), false);
  // Flow run evidence answers with graph proposals too: no report, model-change, scene or artifact proposals.
  assert.equal(isReportSource('flowRun'), false);
  assert.deepEqual(ASSISTANT_SOURCES.filter(isFlowSource), ['flow', 'flowRun']);
  replaceEvidence(captureEvidence('flow'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', model: 'm', content: 'y' }] });
  assert.throws(() => prepareReportDraft('Flow'), /completed analysis answer/);
});
