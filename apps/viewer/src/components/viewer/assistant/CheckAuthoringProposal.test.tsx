/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { SAMPLE_RULES_PROPOSAL, json } from '@/test/check-authoring-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
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
  const malformed = json({ ...SAMPLE_RULES_PROPOSAL, ruleSet: { ...SAMPLE_RULES_PROPOSAL.ruleSet, rules: 'none' } });
  const { parseRulesProposal } = await import('@/lib/check-authoring/rules-proposal');
  const reason = (() => { try { parseRulesProposal(malformed); return ''; } catch (error) { return error instanceof Error ? error.message : String(error); } })();
  assert.ok(reason, 'the parser refuses the proposal');
  answer(malformed);
  const ui = render(<AssistantPanel />);
  await waitFor(() => (ui.textContent ?? '').includes(reason), 'the refusal reason is shown');
  assert.equal(ui.querySelector('section[aria-label="Review information rules"]'), null);
});

// IDS-085: an IDS answer written as JSON is no longer a proposal kind; IDS drafts come from the IDS agent.
test('a JSON IDS answer is not offered for review; the IDS agent card is', async () => {
  await seedAuthoringSample({ editEnabled: false });
  replaceEvidence(captureEvidence('loadReport'));
  answer(json({ version: 1, kind: 'ids.specifications', title: 'Doors', specifications: [] }));
  const ui = render(<AssistantPanel />);
  await waitFor(() => !!ui.querySelector('section[aria-label="Draft IDS with tools"]'), 'the IDS agent card mounts');
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
