/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { render, click, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { useViewerStore } from '@/store';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { setValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import type { ChecklistTemplate } from '@/lib/validation/manual/checklist';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { adapterFor } from './registry';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); setValidationSourceChoice(null); localStorage.clear(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const model = (id: string, fingerprint: string) => ({ ...fixtureModel(id), sourceFingerprint: fingerprint });

function checklist(itemsPerGroup: number): ChecklistTemplate {
  return { version: 1, name: 'Handover review', groups: ['Doors', 'Stairs'].map(name => ({ id: `g-${name}`, name,
    items: Array.from({ length: itemsPerGroup }, (_, i) => ({ id: `${name}-${i}`, text: `${name} check ${i}` })) })) };
}

const payloadOf = (snapshot: ReturnType<typeof captureEvidence>) => JSON.parse(snapshot.payload);

// #6833: manual answers are human decisions; evidence carries them per item and per model,
// with the native summarizeChecklist counts and the latest answer time.
test('manual checklist evidence lists each item per loaded model with the reviewer verdicts (#6833)', () => {
  useViewerStore.setState(fixtureModels(model('arch', 'fp-arch'), model('struct', 'fp-struct')));
  assert.equal(payloadOf(captureEvidence('manualChecklist')).sourceAvailability, 'unavailable', 'no checklist open');
  assert.equal(adapterFor('manualChecklist').readiness(useViewerStore.getState()).ready, false);

  const store = useViewerStore.getState();
  store.setManualChecklist(checklist(2));
  store.setManualAnswer('fp-arch', 'Doors-0', { status: 'pass' });
  store.setManualAnswer('fp-arch', 'Doors-1', { status: 'fail', comment: 'Fire door swings the wrong way' });
  store.setManualAnswer('fp-struct', 'Stairs-0', { status: 'warning' });
  store.setManualAnswer('fp-struct', 'Stairs-1', { comment: 'Not checked yet, waiting for drawings' });
  const latest = useViewerStore.getState().manualAnswers['fp-struct']['Stairs-1'].updatedAt;

  const snapshot = captureEvidence('manualChecklist');
  const payload = payloadOf(snapshot);
  assert.equal(payload.sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 8, 'four items on each of two models');
  const summary = payload.evidence.summary;
  assert.equal(summary.checklistName, 'Handover review');
  assert.equal(summary.itemCount, 4);
  assert.deepEqual(summary.models.map((m: { modelFingerprint: string; counts: unknown }) => [m.modelFingerprint, m.counts]), [
    ['fp-arch', { total: 4, pass: 1, fail: 1, warning: 0, unanswered: 2 }],
    ['fp-struct', { total: 4, pass: 0, fail: 0, warning: 1, unanswered: 3 }],
  ]);
  assert.equal(summary.latestAnswerAt, new Date(latest).toISOString());
  assert.match(summary.limitations, /human verdicts/);
  const rows = payload.evidence.rows.map((r: { data: Record<string, unknown> }) => r.data);
  const failed = rows.find((r: Record<string, unknown>) => r.itemId === 'Doors-1' && r.modelId === 'arch');
  assert.deepEqual([failed.kind, failed.status, failed.groupName, failed.comment], ['manualCheck', 'fail', 'Doors', 'Fire door swings the wrong way']);
  const commentOnly = rows.find((r: Record<string, unknown>) => r.itemId === 'Stairs-1' && r.modelId === 'struct');
  assert.equal(commentOnly.status, null, 'a comment without a verdict stays unanswered');
  assert.equal(rows.find((r: Record<string, unknown>) => r.itemId === 'Doors-0' && r.modelId === 'struct').status, null);

  assert.equal(evidenceIsCurrent(snapshot), true);
  useViewerStore.getState().setManualAnswer('fp-arch', 'Stairs-0', { status: 'pass' });
  assert.equal(evidenceIsCurrent(snapshot), false, 'a new answer replaces the captured checklist state');
  const after = captureEvidence('manualChecklist');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(after), false, 'a model edit makes the attached evidence stale');
});

// #6833: native totals stay exact when the checklist is larger than the row sample.
test('a checklist larger than the row sample keeps exact item totals (#6833)', () => {
  useViewerStore.setState(fixtureModels(model('arch', 'fp-arch')));
  useViewerStore.getState().setManualChecklist(checklist(75));
  useViewerStore.getState().setManualAnswer('fp-arch', 'Stairs-74', { status: 'fail' });
  const snapshot = captureEvidence('manualChecklist');
  const payload = payloadOf(snapshot);
  assert.equal(snapshot.totalRows, 150);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  assert.deepEqual(payload.evidence.summary.models[0].counts, { total: 150, pass: 0, fail: 1, warning: 0, unanswered: 149 });
});

test('an open checklist with no items is available and empty (#6833)', () => {
  useViewerStore.setState(fixtureModels(model('arch', 'fp-arch')));
  useViewerStore.getState().newManualChecklist();
  const snapshot = captureEvidence('manualChecklist');
  assert.equal(payloadOf(snapshot).sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 0);
});

// #6833: the Data validation panel's manual side discusses the manual checklist.
test('Data validation on the manual side attaches the manual checklist from its header (#6833)', () => {
  useViewerStore.setState(fixtureModels(model('arch', 'fp-arch')));
  useViewerStore.getState().setManualChecklist(checklist(1));
  setValidationSourceChoice('manual');
  const panel = render(renderPanelBody('validation', () => undefined));
  const discuss = panel.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(discuss);
  click(discuss);
  const snapshot = useAssistant.getState().snapshot;
  assert.equal(snapshot?.source, 'manualChecklist');
  assert.equal(snapshot?.totalRows, 2);
  act(() => setValidationSourceChoice('ids'));
  assert.equal(panel.querySelector('button[aria-label="Discuss with AI"]'), null, 'the IDS side without a report has nothing to discuss');
});
