/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { captureEvidence } from '@/lib/assistant/evidence';
import { EvidenceView } from './EvidenceView';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });

// #6839: captured scope is independent of later workspace selection and text is inert.
test('historical load context retains captured model identity and explicit row meaning', () => {
  const name = '<img src=x onerror="globalThis.executed=true">.ifc';
  useViewerStore.setState(fixtureModels({ ...fixtureModel('captured'), name }));
  const evidence = captureEvidence('loadReport');
  useViewerStore.setState(fixtureModels({ ...fixtureModel('replacement'), name: 'Later model.ifc' }));
  const ui = render(<EvidenceView evidence={evidence} state="historical" />);
  assert.match(ui.textContent ?? '', /Historical evidence/);
  assert.match(ui.textContent ?? '', /Rows represent model load reports/);
  assert.match(ui.textContent ?? '', /Unavailable diagnostics are not clean loads/);
  assert.match(ui.textContent ?? '', /1 of 1 metadata entries/);
  assert.ok(ui.textContent?.includes(name));
  assert.ok(ui.textContent?.includes(evidence.payload));
  assert.doesNotMatch(ui.textContent ?? '', /Later model/);
  assert.equal(ui.querySelector('img'), null);
  assert.equal(ui.querySelector('time')?.getAttribute('datetime'), evidence.capturedAt);
});

test('large federation shows actual included metadata and omission instead of inventing complete scope', () => {
  useViewerStore.setState({ models: new Map(Array.from({ length: 120 }, (_, index) => {
    const model = { ...fixtureModel(`m${index}`), name: `Model ${index}.ifc` }; return [model.id, model];
  })) });
  const evidence = captureEvidence('loadReport');
  const ui = render(<EvidenceView evidence={evidence} state="captured" />);
  assert.match(ui.textContent ?? '', /100 of 120 metadata entries/);
  assert.match(ui.textContent ?? '', /Some model metadata was omitted or shortened/);
  assert.match(ui.textContent ?? '', /This snapshot is a sample. Unseen rows are not evaluated/);
  assert.match(ui.textContent ?? '', /does not establish which models an analysis evaluated/);
  assert.equal(ui.querySelectorAll('li').length, 100);
});

test('stale empty source and older portable envelopes never acquire current scope', () => {
  const evidence = captureEvidence('clash');
  const ui = render(<EvidenceView evidence={{ ...evidence, payload: '{}' }} state="stale" />);
  assert.match(ui.textContent ?? '', /Stale workspace evidence/);
  assert.match(ui.textContent ?? '', /Frozen evidence: 0 of 0/);
  assert.match(ui.textContent ?? '', /Model metadata is unavailable/);
  assert.doesNotMatch(ui.textContent ?? '', /0 of 0 metadata entries/);
});

// #6856: absence and an empty attached native report have different meanings.
test('missing native sources offer the matching native workflow rather than zero findings', () => {
  useViewerStore.setState({ clashResult: null, idsValidationReport: null, compareResult: null, flowDoc: null, models: new Map() });
  // Flow is not listed: with no graph open, describing a new graph is a captured native state (#6919).
  for (const source of ['clash', 'validation', 'compare'] as const) {
    const evidence = captureEvidence(source);
    const ui = render(<EvidenceView evidence={evidence} state="captured" />);
    assert.equal(JSON.parse(evidence.payload).sourceAvailability, 'unavailable');
    assert.match(ui.textContent ?? '', /available at capture/);
    assert.match(ui.textContent ?? '', /refresh the evidence/);
    assert.doesNotMatch(ui.textContent ?? '', /Frozen evidence: 0 of 0/);
    cleanup();
  }
  assert.equal(JSON.parse(captureEvidence('flow').payload).sourceAvailability, 'available');
  // #7326: capability remains in the summary while the absent load report is unavailable.
  const models = captureEvidence('loadReport'), payload = JSON.parse(models.payload);
  assert.equal(payload.sourceAvailability, 'unavailable');
  assert.equal(payload.totalRows, 0); assert.equal(payload.evidence.summary.loadReportsAvailable, false);
  assert.equal(payload.evidence.summary.cleanLoads, 0);
  assert.equal(payload.evidence.summary.nativeNewIfc.existingModelFacts, false);
  const ui = render(<EvidenceView evidence={models} state="captured" />);
  assert.ok(ui.textContent?.includes('native-new-ifc-scaffold'));
  const rendered = JSON.parse(ui.querySelector('pre')!.textContent ?? '{}');
  assert.equal(rendered.evidence.summary.loadReportsAvailable, false);
});

test('a captured empty clash report keeps native settings and scope without a clean verdict', async () => {
  const { summarizeClashes } = await import('@ifc-lite/clash');
  useViewerStore.setState({ ...fixtureModels(fixtureModel('a')), clashResult: {
    clashes: [], summary: summarizeClashes([]), rulesRun: [], settings: { tolerance: 0.002, excludeVoidsAndHosts: true },
  } });
  const evidence = captureEvidence('clash');
  const payload = JSON.parse(evidence.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(payload.evidence.summary.total, 0);
  assert.equal(payload.evidence.summary.settings.tolerance, 0.002);
  useViewerStore.setState({ clashResult: null });
  const ui = render(<EvidenceView evidence={evidence} state="historical" />);
  assert.match(ui.textContent ?? '', /captured native source contains no result rows/);
  assert.match(ui.textContent ?? '', /does not establish that the models are free of issues/);
  assert.doesNotMatch(ui.textContent ?? '', /No native clash result was available/);
});

test('older zero-row archives remain unknown rather than becoming an empty native check', () => {
  const evidence = captureEvidence('clash');
  const ui = render(<EvidenceView evidence={{ ...evidence, payload: '{}' }} state="historical" />);
  assert.match(ui.textContent ?? '', /does not record whether a native source was available/);
  assert.match(ui.textContent ?? '', /Zero rows are not a clean verdict/);
  assert.doesNotMatch(ui.textContent ?? '', /captured native source contains no result rows/);
});
