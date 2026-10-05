/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, type, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { SAMPLE_IDS_PROPOSAL, SAMPLE_RULES_PROPOSAL, json } from '@/test/check-authoring-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { loadDefinitionLibrary } from '@/lib/validation/definition-library';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { AssistantPanel } from './AssistantPanel';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useViewerStore.setState(initial, true); localStorage.clear();
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
  useValidationSourceChoice.setState({ choice: null });
});

function answer(content: string) {
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Draft checks' }, { role: 'assistant', model: 'recorded', content }] }));
}
const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find(candidate => name.test(candidate.textContent ?? '') || name.test(candidate.getAttribute('aria-label') ?? ''));
  assert.ok(found, `button ${name}`);
  return found;
};

// #6915: answer → proposal card → native audit → dry run → save → native handoff, never saved by itself.
test('an IDS answer is audited, dry-run on the loaded model, edited inline and saved only after review', async () => {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  answer(json({ ...SAMPLE_IDS_PROPOSAL, unsupported: [{ text: 'Doors swing outwards on escape routes', reason: 'opening direction is geometry' }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Review IDS draft"]'), 'the IDS review card mounts');
  assert.match(ui.textContent ?? '', /IDS draft/);
  assert.match(ui.textContent ?? '', /3 specifications · 1 requirement not checkable/);
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review IDS draft"]')!;
  await waitFor(() => /Native IDS audit: 0 errors/.test(review.textContent ?? ''), 'the native audit finishes clean');
  assert.match(review.textContent ?? '', /Doors swing outwards on escape routes/, 'the unsupported requirement is shown');
  assert.equal(button(review, /Save to IDS library/).disabled, true, 'saving needs a dry run');
  assert.equal(loadDefinitionLibrary().library.entries.length, 0);

  click(button(review, /Dry run on loaded models/));
  await waitFor(() => !!review.querySelector('section[aria-label="Dry-run results"]'), 'dry-run results appear');
  const results = review.querySelector<HTMLElement>('section[aria-label="Dry-run results"]')!;
  assert.match(results.textContent ?? '', /Dry run on 1 model/);
  assert.match(results.textContent ?? '', /\d+ applicable · \d+ passed · [1-9]\d* failed/);
  click(button(results, /^Show .* in the model$/));
  const selected = useViewerStore.getState().selectedEntity;
  assert.equal(selected?.modelId, SAMPLE_MODEL, 'a failing sample resolves in the live model');
  assert.equal(button(review, /Save to IDS library/).disabled, false);

  type(review.querySelector<HTMLInputElement>('#ids-draft-spec-0-name')!, 'Spaces carry a name');
  assert.match(review.textContent ?? '', /changed after this dry run/);
  assert.equal(button(review, /Save to IDS library/).disabled, true, 'an inline edit needs a new dry run');
  click(button(review, /Dry run on loaded models/));
  await waitFor(() => !button(review, /Save to IDS library/).disabled, 'the edited draft dry-runs');
  click(button(review, /Save to IDS library/));
  assert.match(review.textContent ?? '', /Saved as the active IDS/);
  const [entry] = loadDefinitionLibrary().library.entries;
  assert.ok(entry && entry.kind === 'ids');
  assert.equal(entry.document.specifications[0].name, 'Spaces carry a name');
  assert.match(entry.document.info.description ?? '', /Doors swing outwards/);
  click(button(review, /Open in Data validation/));
  assert.equal(useValidationSourceChoice.getState().choice, 'ids');
});

test('a rules answer is dry-run through the native engine and opens in the rule editor after saving', async () => {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  answer(json(SAMPLE_RULES_PROPOSAL));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Review information rules"]'), 'the rules review card mounts');
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review information rules"]')!;
  assert.match(review.textContent ?? '', /property Pset_WallCommon\.FireRating isSet/);
  click(button(review, /Dry run on loaded models/));
  await waitFor(() => !button(review, /Save as rule set/).disabled, 'the rules dry-run');
  click(button(review, /Save as rule set/));
  click(button(review, /Open in the rule editor/));
  assert.equal(useViewerStore.getState().validationRuleSetEditing, true);
  assert.equal(useViewerStore.getState().validationRuleSetDraft?.rules.length, 2);
});

test('a malformed check proposal is a refused card with its reason, never a review', async () => {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  answer(json({ ...SAMPLE_IDS_PROPOSAL, specifications: [{ name: 'Walls', applicability: [], requirements: [{ type: 'attribute', name: 'Name' }] }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => /applicability must list 1 to 20 facets/.test(ui.textContent ?? ''), 'the refusal reason is shown');
  assert.equal(ui.querySelector('section[aria-label="Review IDS draft"]'), null);
});

test('a report outline from validation evidence previews live table rows and saves a new document', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const { parseIDS } = await import('@ifc-lite/ids');
  const { runIdsCheck } = await import('@/lib/validation/run-ids-check');
  const { SAMPLE_IDS_XML } = await import('@/test/check-authoring-fixture');
  const state = useViewerStore.getState();
  const { report } = await runIdsCheck({ document: parseIDS(SAMPLE_IDS_XML), modelId: SAMPLE_MODEL, dataStore: state.models.get(SAMPLE_MODEL)!.ifcDataStore!,
    locale: 'en', models: state.models });
  useViewerStore.setState({ idsValidationReport: report });
  replaceEvidence(captureEvidence('validation'));
  const failed = report.specificationResults[1].failedCount;
  answer(json({ version: 1, kind: 'document.outline', title: 'Wall findings', sections: [{ heading: 'Findings', purpose: 'findings',
    blocks: [{ kind: 'validationTable', specification: 'spec-1', rows: 'failed', columns: ['name', 'reason'] }] }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Review report outline"]'), 'the outline review mounts');
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review report outline"]')!;
  assert.match(review.textContent ?? '', new RegExp(`live: ${failed} failed rows? now for spec-1`));
  click(button(review, /Save as new document/));
  await waitFor(() => /Saved to the Documents library/.test(review.textContent ?? ''), 'the document saves');
  click(button(review, /Open in Documents/));
  const active = useViewerStore.getState().activeDocumentId;
  assert.ok(active && useViewerStore.getState().documents.some(document => document.id === active && document.name === 'Wall findings'));
});
