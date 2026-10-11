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
  assert.match(review.textContent ?? '', /Saved to the Data validation IDS library/);
  const [entry] = loadDefinitionLibrary().library.entries;
  assert.ok(entry && entry.kind === 'ids');
  assert.equal(entry.document.specifications[0].name, 'Spaces carry a name');
  assert.match(entry.document.info.description ?? '', /Doors swing outwards/);
  assert.equal(useViewerStore.getState().validationDefinitions.active.ids, null, 'saving does not switch the active IDS');
  click(button(review, /Open in Data validation/));
  assert.equal(useViewerStore.getState().validationDefinitions.active.ids, entry.id, 'opening it does');
  assert.equal(useValidationSourceChoice.getState().choice, 'ids');
});

// #6915 review: 2400 mm is stored as 2.4 (IDS is SI); the review shows the conversion and labels the SI value it edits.
test('a value authored in a declared unit shows its SI conversion, and the edited value is labelled and read back in SI', async () => {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  answer(json({ version: 1, kind: 'ids.specifications', title: 'Doors', specifications: [{ name: 'Doors are wide', applicability: [{ type: 'entity', name: 'IFCDOOR' }],
    requirements: [{ type: 'property', propertySet: 'Qto_DoorBaseQuantities', baseName: 'Width', dataType: 'IFCLENGTHMEASURE', unit: 'mm', value: 2400 }] }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Review IDS draft"]'), 'the IDS review card mounts');
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review IDS draft"]')!;
  assert.match(review.textContent ?? '', /Authored in mm, stored in SI: 2400 mm → 2\.4 m/);
  const field = review.querySelector<HTMLInputElement>('#ids-draft-spec-0-req-0-value')!;
  assert.equal(field.value, '2.4');
  assert.equal(review.querySelector('label[for="ids-draft-spec-0-req-0-value"]')?.textContent, 'Required value (m)');
  type(field, '3');
  assert.match(review.textContent ?? '', /3000 mm → 3 m/, 'an edit is read back in the declared unit');
});

// #6915 review: an audit that could not run is not a clean audit.
test('an IDS audit that fails to run blocks saving and export, and stays shown after a dry run', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const { IdsDraftReview } = await import('../check-authoring/IdsDraftReview');
  const { parseIdsProposal } = await import('@/lib/check-authoring/ids-proposal');
  const ui = render(<IdsDraftReview initial={parseIdsProposal(json(SAMPLE_IDS_PROPOSAL))} audit={() => Promise.reject(new Error('schema data failed to load'))} />);
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review IDS draft"]')!;
  await waitFor(() => /audit could not run/.test(review.textContent ?? ''), 'the audit failure is shown');
  assert.doesNotMatch(review.textContent ?? '', /0 errors/);
  assert.match(review.textContent ?? '', /schema data failed to load/);
  assert.equal(button(review, /Export \.ids/).disabled, true);
  click(button(review, /Dry run on loaded models/));
  await waitFor(() => !!review.querySelector('section[aria-label="Dry-run results"]'), 'the dry run completes');
  assert.equal(button(review, /Save to IDS library/).disabled, true, 'a current dry run does not unblock an audit that never ran');
  assert.equal(button(review, /Export \.ids/).disabled, true);
  assert.match(review.textContent ?? '', /audit could not run/, 'the failure is not cleared by the dry run');
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
  assert.equal(useViewerStore.getState().validationRuleSetEditing, false, 'saving does not open the editor');
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

// #7115: use the real adapter capture, including its composite report/side identity.
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

// #6915 review: report specification ids are positional, so a later IDS run can reuse spec-1 for another specification.
test('an outline bound to a specification is refused once another validation run replaces the report it was drafted from', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const { parseIDS } = await import('@ifc-lite/ids');
  const { runIdsCheck } = await import('@/lib/validation/run-ids-check');
  const { SAMPLE_IDS_XML } = await import('@/test/check-authoring-fixture');
  const state = useViewerStore.getState();
  const run = async () => (await runIdsCheck({ document: parseIDS(SAMPLE_IDS_XML), modelId: SAMPLE_MODEL, dataStore: state.models.get(SAMPLE_MODEL)!.ifcDataStore!,
    locale: 'en', models: state.models })).report;
  useViewerStore.setState({ idsValidationReport: await run() });
  replaceEvidence(captureEvidence('validation'));
  answer(json({ version: 1, kind: 'document.outline', title: 'Wall findings', sections: [{ heading: 'Findings', purpose: 'findings',
    blocks: [{ kind: 'validationTable', specification: 'spec-1', rows: 'failed', columns: ['name', 'reason'] }] }] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Review report outline"]'), 'the outline review mounts');
  const review = ui.querySelector<HTMLElement>('section[aria-label="Review report outline"]')!;
  assert.equal(button(review, /Save as new document/).disabled, false);
  const rerun = await run();
  act(() => useViewerStore.setState({ idsValidationReport: rerun }));
  assert.match(review.textContent ?? '', /spec-1 was drafted from a different validation report than the one shown now/);
  assert.doesNotMatch(review.textContent ?? '', /live: \d+ failed rows? now for spec-1/, 'no rows are shown from the other report');
  assert.equal(button(review, /Save as new document/).disabled, true);
});
