/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7375: reviewed source requirements dispatched into native IDS checks,
 * information rules and a manual-review document. Runs on the committed
 * SketchUp-authored `building-architecture` sample (4 walls, Widths 200/200/200/24 mm,
 * Pset_WallCommon.IsExternal) with a source text frozen into real semantic
 * evidence, through the unchanged P07 audit, dry run and save.
 */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { act } from 'react';
import { render, click, cleanup, waitFor } from '@/test/render';
import { useViewerStore } from '@/store';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { attachSourceText, detachSourceText, useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';
import { xxhash64Hex } from '@ifc-lite/cache';
import { loadDefinitionLibrary } from '@/lib/validation/definition-library';
import { useValidationSourceChoice } from '@/lib/validation/validation-source-choice';
import { SemanticProposalReview } from './SemanticProposalReview';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); useSemanticSourceTexts.setState({ sources: [] });
  useViewerStore.setState(initial, true); localStorage.clear();
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
  useValidationSourceChoice.setState({ choice: null });
});

const SPEC = [
  '3 Model requirements',
  '3.2 External walls shall be identified: Pset_WallCommon.IsExternal shall be TRUE.',
  '3.3 Every wall shall be at least 150 mm thick, recorded as Qto_WallBaseQuantities.Width.',
  '3.4 A fire-safety strategy report shall be delivered with each model issue.',
  '3.5 Wall finishes shall not be Red.',
].join('\n\n');
const span = (quote: string) => ({ source: 'S1', start: SPEC.indexOf(quote), end: SPEC.indexOf(quote) + quote.length, quote });
// The source revision is the portable xxh64 of the attached text, computed independently of the dispatch.
const REVISION = xxhash64Hex(new TextEncoder().encode(SPEC));

const REQUIREMENTS = { version: 1, kind: 'semantic.requirements', title: 'Wall requirements', requirements: [
  { id: 'R1', statement: 'External walls are flagged as external', appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.IsExternal',
    operator: 'equals', value: true, span: span('Pset_WallCommon.IsExternal shall be TRUE') },
  { id: 'R2', statement: 'Walls are at least 150 mm thick', appliesTo: { ifcClass: 'IfcWall' }, property: 'Qto_WallBaseQuantities.Width',
    operator: 'atLeast', value: 150, unit: 'mm', span: span('at least 150 mm thick') },
  { id: 'R3', statement: 'A fire-safety strategy report is delivered with each model issue', span: span('A fire-safety strategy report shall be delivered with each model issue.') },
  { id: 'R4', statement: 'Wall finishes are not red', appliesTo: { ifcClass: 'IfcWall' }, property: 'Pset_WallCommon.Finish', operator: 'notEquals', value: 'Red',
    span: span('Wall finishes shall not be Red.') },
  { id: 'R5', statement: 'Paraphrased', appliesTo: { ifcClass: 'IfcWall' }, property: 'Name', operator: 'exists', span: span('3 Model requirements'), },
], unsupported: [] };
// R5 quotes the right text at the wrong offsets: its span does not verify.
REQUIREMENTS.requirements[4].span = { ...REQUIREMENTS.requirements[4].span, start: 1, end: 21 };

async function converse(answer: unknown = REQUIREMENTS) {
  await seedAuthoringSample({ editEnabled: false });
  // The evidence register reads attached texts once the Linked records chunk is loaded, as when a user attaches one.
  await import('@/components/viewer/SemanticPanel');
  attachSourceText('Employer information requirements', SPEC);
  replaceEvidence(captureEvidence('semantic'));
  act(() => useAssistant.setState({ messages: [{ role: 'user', content: 'Extract' }, { role: 'assistant', model: 'recorded', content: JSON.stringify(answer) }] }));
}
const button = (root: HTMLElement, name: RegExp) => {
  const found = [...root.querySelectorAll('button')].find(candidate => name.test(candidate.textContent ?? ''));
  assert.ok(found, `button ${name}`);
  return found;
};
const card = (root: HTMLElement, label: string) => root.querySelector<HTMLElement>(`section[aria-label="${label}"]`);
/** The review, once the schema's quantity measures have loaded and the native targets show. */
async function mount() {
  const ui = render(<SemanticProposalReview />);
  await waitFor(() => card(ui, 'Native checks and documents') !== null, 'the native targets show');
  return ui;
}

test('#7375 a reviewed requirement set is dispatched, on request, into native IDS, rule and document records that keep their source linkage', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents');
  assert.ok(dispatch, 'the requirement review offers native targets');
  const rows = [...dispatch.querySelectorAll('li')].map(row => row.textContent ?? '');
  assert.match(rows[0], /R1 IDS check/);
  assert.match(rows[1], /R2 Information rule on a model quantity/);
  assert.match(rows[2], /R3 Manual check, listed in a document/);
  assert.match(rows[3], /R4 No native check: IDS cannot express this comparison/);
  assert.match(rows[4], /R5 No native check: the quote does not match the attached text/);
  assert.equal(card(ui, 'Review IDS draft') === null, true, 'nothing is dispatched until asked');
  assert.equal(loadDefinitionLibrary().library.entries.length, 0);

  click(button(dispatch, /Prepare native drafts/));
  const ids = card(ui, 'Review IDS draft')!, rules = card(ui, 'Review information rules')!, outline = card(ui, 'Review report outline')!;
  assert.ok(ids && rules && outline, 'one draft per native target');

  // IDS: native audit, dry run on the real model, then the canonical IDS library.
  await waitFor(() => /Native IDS audit: 0 errors/.test(ids.textContent ?? ''), 'the IDS draft audits clean');
  assert.equal(button(ids, /Save to IDS library/).disabled, true, 'saving needs a dry run');
  click(button(ids, /Dry run on loaded models/));
  await waitFor(() => !button(ids, /Save to IDS library/).disabled, 'the IDS draft dry-runs');
  assert.match(ids.textContent ?? '', /Dry run on 1 model/);
  click(button(ids, /Save to IDS library/));
  // Rules: the quantity rule runs through the native engine, in SI.
  assert.match(rules.textContent ?? '', /quantity Qto_WallBaseQuantities\.Width\.si gte 0\.15/);
  click(button(rules, /Dry run on loaded models/));
  await waitFor(() => !button(rules, /Save as rule set/).disabled, 'the rule draft dry-runs');
  // Three sample walls are 200 mm wide; the fourth records Width 24 (mm), so it fails 150 mm.
  assert.match(rules.textContent ?? '', /4 applicable · 3 passed · 1 failed/);
  click(button(rules, /Save as rule set/));
  // Document: manual and unresolved items stay visible as not checked.
  assert.match(outline.textContent ?? '', /A fire-safety strategy report/);
  assert.match(outline.textContent ?? '', /Unresolved: no native check expresses this comparison/);
  click(button(outline, /Save as new document/));
  await waitFor(() => /Saved to the Documents library/.test(outline.textContent ?? ''), 'the document saves');

  // Reload: what the libraries hold, read back from storage.
  const entries = loadDefinitionLibrary().library.entries;
  const idsEntry = entries.find(entry => entry.kind === 'ids'), ruleEntry = entries.find(entry => entry.kind === 'rules');
  assert.ok(idsEntry?.kind === 'ids' && ruleEntry?.kind === 'rules');
  const [spec] = idsEntry.document.specifications;
  assert.equal(idsEntry.document.specifications.length, 1, 'only the IDS-classified requirement');
  assert.equal(spec.identifier, 'source-R1');
  assert.equal(spec.description, 'External walls are flagged as external');
  assert.equal(spec.instructions, `Source requirement R1 from S1 "Employer information requirements" (revision ${REVISION}, ${SPEC.length} characters), `
    + `characters ${SPEC.indexOf('Pset_WallCommon.IsExternal')}-${SPEC.indexOf('Pset_WallCommon.IsExternal') + 40}: "Pset_WallCommon.IsExternal shall be TRUE".`);
  assert.ok(idsEntry.xml.includes(`revision ${REVISION}`), 'the exported XML carries the linkage');
  const [rule] = ruleEntry.file.rules;
  assert.equal(ruleEntry.file.rules.length, 1);
  assert.match(rule.description ?? '', /^Walls are at least 150 mm thick\nSource requirement R2 from S1 .*"at least 150 mm thick"\. Stated unit: mm\.$/);
  const saved = useViewerStore.getState().documents.find(document => document.name === 'Wall requirements');
  const stored = JSON.stringify(saved?.blocks ?? []);
  assert.match(stored, /R3: A fire-safety strategy report is delivered with each model issue/);
  assert.match(stored, /Manual requirement: check it by inspection; no automatic result is recorded/);
  assert.match(stored, /R4: Wall finishes are not red/);
  assert.match(stored, /R5: Paraphrased/);
  assert.doesNotMatch(stored, /R1: External walls/, 'checked requirements are not repeated as manual items');

  // Handoff: the native rule editor opens the saved rule with its provenance.
  click(button(rules, /Open in the rule editor/));
  assert.match(useViewerStore.getState().validationRuleSetDraft?.rules[0].description ?? '', /Source requirement R2 from S1/);
});

test('#7375 an excluded requirement stays in the review only and reaches no native draft', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  click(dispatch.querySelector<HTMLInputElement>('input[aria-label="Include R1 in the native drafts"]')!);
  click(dispatch.querySelector<HTMLInputElement>('input[aria-label="Include R3 in the native drafts"]')!);
  click(button(dispatch, /Prepare native drafts/));
  assert.equal(card(ui, 'Review IDS draft') === null, true, 'R1 was the only IDS requirement');
  assert.ok(card(ui, 'Review information rules'));
  const outline = card(ui, 'Review report outline')!;
  assert.doesNotMatch(outline.textContent ?? '', /fire-safety strategy/);
  assert.match(outline.textContent ?? '', /R4: Wall finishes are not red/);
  assert.equal(dispatch.querySelector<HTMLInputElement>('input[aria-label="Include R2 in the native drafts"]')!.disabled, true,
    'targets are fixed once drafts are prepared');
});

test('#7375 a changed or missing source refuses dispatch and withdraws unsaved drafts without touching saved records', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  click(button(dispatch, /Prepare native drafts/));
  const rules = card(ui, 'Review information rules')!;
  click(button(rules, /Dry run on loaded models/));
  await waitFor(() => !button(rules, /Save as rule set/).disabled, 'the rule draft dry-runs');
  click(button(rules, /Save as rule set/));
  assert.equal(loadDefinitionLibrary().library.entries.length, 1);

  // Re-attach different text under the same id: S1 no longer says what the assistant read.
  act(() => { detachSourceText('S1'); attachSourceText('Employer information requirements', SPEC.replace('150 mm', '300 mm')); });
  assert.match(dispatch.textContent ?? '', /source text changed after the drafts were prepared/);
  assert.equal(card(ui, 'Review IDS draft') === null, true, 'unsaved drafts are withdrawn');
  assert.equal(card(ui, 'Review information rules') === null, true);
  assert.match(dispatch.textContent ?? '', /R1 No native check: the source text changed after the assistant read it/);
  const [entry] = loadDefinitionLibrary().library.entries;
  assert.ok(entry?.kind === 'rules');
  assert.match(entry.file.rules[0].description ?? '', new RegExp(`revision ${REVISION}`), 'the saved rule keeps the revision it was reviewed against');

  act(() => detachSourceText('S1'));
  assert.match(dispatch.textContent ?? '', /R1 No native check: the source text is no longer attached/);
});

test('#7375 after withdrawal the reviewer can prepare the drafts again from the current source', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  click(button(dispatch, /Prepare native drafts/));
  assert.ok(card(ui, 'Review information rules'));
  // Re-attach the same wording under the same id with one extra trailing passage: the frozen passages still read the same.
  const changed = `${SPEC}\n\n3.6 Added later.`;
  act(() => { detachSourceText('S1'); attachSourceText('Employer information requirements', changed); });
  assert.match(dispatch.textContent ?? '', /source text changed after the drafts were prepared/);
  assert.equal(dispatch.querySelector<HTMLInputElement>('input[aria-label="Include R2 in the native drafts"]')!.disabled, false, 'targets can be changed again');
  click(button(dispatch, /Prepare native drafts/));
  const rules = card(ui, 'Review information rules');
  assert.ok(rules, 'the drafts are prepared again');
  assert.doesNotMatch(dispatch.textContent ?? '', /source text changed after the drafts were prepared/);
  click(button(rules, /Dry run on loaded models/));
  await waitFor(() => !button(rules, /Save as rule set/).disabled, 'the re-prepared rule draft dry-runs');
  click(button(rules, /Save as rule set/));
  const [entry] = loadDefinitionLibrary().library.entries;
  assert.ok(entry?.kind === 'rules');
  assert.match(entry.file.rules[0].description ?? '', new RegExp(`revision ${xxhash64Hex(new TextEncoder().encode(changed))}, ${changed.length} characters`),
    'the re-prepared record cites the source as it is now');
});

test('#7375 a document draft of only unresolved requirements is withdrawn too when their source changes', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  for (const id of ['R1', 'R2', 'R3', 'R5']) click(dispatch.querySelector<HTMLInputElement>(`input[aria-label="Include ${id} in the native drafts"]`)!);
  click(button(dispatch, /Prepare native drafts/));
  const outline = card(ui, 'Review report outline')!;
  assert.match(outline.textContent ?? '', new RegExp(`R4: Wall finishes are not red\\s*Source requirement R4 from S1 .*revision ${REVISION}`),
    'the unresolved item keeps its verified passage and revision');
  act(() => { detachSourceText('S1'); attachSourceText('Employer information requirements', SPEC.replace('Red', 'Blue')); });
  assert.equal(card(ui, 'Review report outline') === null, true, 'the outdated document draft can no longer be saved');
  assert.match(dispatch.textContent ?? '', /source text changed after the drafts were prepared/);
});

test('#7375 a source detached before dispatch leaves only not-checked items', async () => {
  await converse();
  act(() => detachSourceText('S1'));
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  assert.match(dispatch.textContent ?? '', /R2 No native check: the source text is no longer attached/);
  click(button(dispatch, /Prepare native drafts/));
  assert.equal(card(ui, 'Review IDS draft') === null, true);
  assert.equal(card(ui, 'Review information rules') === null, true);
  assert.match(card(ui, 'Review report outline')?.textContent ?? '', /its source text is no longer attached/);
});

const only = (dispatch: HTMLElement, keep: readonly string[]) => {
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) if (!keep.includes(id)) click(dispatch.querySelector<HTMLInputElement>(`input[aria-label="Include ${id} in the native drafts"]`)!);
};
const reattach = (text: string) => act(() => { detachSourceText('S1'); attachSourceText('Employer information requirements', text); });

test('#7375 a draft citing only an unverified span is withdrawn when that source changes', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  only(dispatch, ['R5']);
  click(button(dispatch, /Prepare native drafts/));
  assert.match(card(ui, 'Review report outline')?.textContent ?? '', /R5: Paraphrased\s*Cited from S1, characters 1-21/);
  reattach(`${SPEC}\n\n3.6 Added later.`);
  assert.equal(card(ui, 'Review report outline') === null, true);
  assert.match(dispatch.textContent ?? '', /source text changed after the drafts were prepared/);
});

test('#7375 a draft citing only an unsupported item is withdrawn when that source changes', async () => {
  const quote = '3.4 A fire-safety strategy report shall be delivered with each model issue.';
  await converse({ ...REQUIREMENTS, unsupported: [{ text: 'A strategy report is delivered', reason: 'Not a model property', span: span(quote) }] });
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  only(dispatch, []);
  click(button(dispatch, /Prepare native drafts/));
  const outline = card(ui, 'Review report outline')!;
  assert.match(outline.textContent ?? '', new RegExp(`A strategy report is delivered\\s*Source passage from S1 .*revision ${REVISION}`), 'the unsupported item keeps its passage');
  reattach(`${SPEC}\n\n3.6 Added later.`);
  assert.equal(card(ui, 'Review report outline') === null, true);
});

test('#7375 a source that had already changed before preparing still withdraws the drafts when it changes again', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  reattach(SPEC.replace('Red', 'Blue'));
  click(button(dispatch, /Prepare native drafts/));
  assert.ok(card(ui, 'Review report outline'), 'everything is listed as not checked');
  reattach(SPEC.replace('Red', 'Green'));
  assert.equal(card(ui, 'Review report outline') === null, true);
});

test('#7375 a different proposal in the same review withdraws the drafts prepared from the previous one', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  click(button(dispatch, /Prepare native drafts/));
  assert.ok(card(ui, 'Review information rules'));
  // The last answer is replaced in place (same message count, same review), now without R2.
  const replaced = { ...REQUIREMENTS, requirements: REQUIREMENTS.requirements.filter(item => item.id !== 'R2') };
  act(() => useAssistant.setState(state => ({ messages: [...state.messages.slice(0, -1), { role: 'assistant', model: 'recorded', content: JSON.stringify(replaced) }] })));
  const now = card(ui, 'Native checks and documents')!;
  assert.equal(card(ui, 'Review information rules') === null, true, 'no draft of the previous proposal stays saveable');
  assert.doesNotMatch(now.textContent ?? '', /R2 /);
  assert.ok(button(now, /Prepare native drafts/));
});

test('#7375 an excluded unresolved requirement is not announced as listed in the document', async () => {
  await converse();
  const ui = await mount();
  const dispatch = card(ui, 'Native checks and documents')!;
  const row = (id: string) => [...dispatch.querySelectorAll('li')].find(item => item.textContent?.startsWith(`${id} `))?.textContent ?? '';
  assert.match(row('R4'), /Listed in the document as not checked/);
  click(dispatch.querySelector<HTMLInputElement>('input[aria-label="Include R4 in the native drafts"]')!);
  assert.doesNotMatch(row('R4'), /Listed in the document/);
  click(button(dispatch, /Prepare native drafts/));
  assert.doesNotMatch(card(ui, 'Review report outline')?.textContent ?? '', /R4:/, 'and it is not');
});

test('#7375 the IDS draft targets the IFC version of the loaded model', async () => {
  await converse();
  const { models } = useViewerStore.getState();
  useViewerStore.setState({ models: new Map([...models].map(([id, model]) => [id, { ...model, schemaVersion: 'IFC2X3' as const }])) });
  const ui = await mount();
  click(button(card(ui, 'Native checks and documents')!, /Prepare native drafts/));
  const ids = card(ui, 'Review IDS draft')!;
  await waitFor(() => /Native IDS audit: 0 errors/.test(ids.textContent ?? ''), 'the IDS draft audits clean');
  click(button(ids, /Dry run on loaded models/));
  await waitFor(() => !button(ids, /Save to IDS library/).disabled, 'the IDS draft dry-runs');
  click(button(ids, /Save to IDS library/));
  const entry = loadDefinitionLibrary().library.entries.find(candidate => candidate.kind === 'ids');
  assert.ok(entry?.kind === 'ids');
  assert.deepEqual(entry.document.specifications[0].ifcVersions, ['IFC2X3']);
});

test('#7375 with only IFC5 models loaded the IDS draft is refused, not targeted at IFC4', async () => {
  await converse();
  const { models } = useViewerStore.getState();
  assert.ok(models.size > 0);
  useViewerStore.setState({ models: new Map([...models].map(([id, model]) => [id, { ...model, schemaVersion: 'IFC5' as const }])) });
  const ui = await mount();
  click(button(card(ui, 'Native checks and documents')!, /Prepare native drafts/));
  assert.equal(card(ui, 'Review IDS draft') === null, true);
  assert.match(ui.textContent ?? '', /The IDS draft was refused: none of the loaded models has an IFC version IDS can check/);
  assert.ok(card(ui, 'Review information rules'), 'the other targets are unaffected');
});
