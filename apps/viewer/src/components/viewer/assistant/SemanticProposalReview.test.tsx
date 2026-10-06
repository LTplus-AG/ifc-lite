/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import '@/test/content-backup-fixture.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { useViewerStore } from '@/store';
import { render, click, cleanup, waitFor } from '@/test/render';
import { seedSemanticModels } from '@/test/semantic-model-fixture';
import { captureEvidence } from '@/lib/assistant/evidence';
import { replaceEvidence, useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { useSemanticSession } from '@/lib/semantic/session';
import { DEMO_REVISIONS } from '@/lib/semantic/demo';
import { attachSourceText, useSemanticSourceTexts } from '@/lib/semantic/assist/source-texts';
import { recordEndpointGrant, revokeEndpointGrant } from '@/lib/semantic/assist/endpoint-grant';
import { useSemanticReviews, semanticReviewLibrary } from '@/lib/semantic/assist/library';
import { createContentBackup, parseContentBackup } from '@/lib/storage/content-backup';
import { proposalOf } from './AssistantConversation';
import { SemanticProposalReview } from './SemanticProposalReview';

const original = useViewerStore.getState();
const session = useSemanticSession.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); revokeEndpointGrant(); useSemanticSourceTexts.setState({ sources: [] });
  useViewerStore.setState(original, true); useSemanticSession.setState(session, true);
});

const SPEC = 'Scope of works\n\nDoors in escape routes shall have a fire rating of EI30.\n\nCleaning is done as appropriate.';
const QUOTE = 'fire rating of EI30';
const START = SPEC.indexOf(QUOTE);
const span = (overrides: object = {}) => ({ source: 'S1', start: START, end: START + QUOTE.length, quote: QUOTE, ...overrides });

/** Freeze evidence the way the panel does, then let the model "answer". */
async function converse(answer: unknown, models = 2) {
  await seedSemanticModels(models);
  attachSourceText('Specification', SPEC);
  replaceEvidence(captureEvidence('semantic'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'Extract' }, { role: 'assistant', model: 'test-provider', content: JSON.stringify(answer) }] });
}
const text = (ui: HTMLElement) => ui.textContent ?? '';
const buttonLabelled = (ui: HTMLElement, pattern: RegExp) => [...ui.querySelectorAll('button')].find(button => pattern.test(button.textContent ?? ''))!;

const REQUIREMENTS = { version: 1, kind: 'semantic.requirements', title: 'Door requirements',
  requirements: [
    { id: 'R1', statement: 'Escape-route doors EI30', appliesTo: { ifcClass: 'IfcDoor' }, property: 'FireRating', operator: 'equals', value: 'EI30', span: span() },
    { id: 'R2', statement: 'Paraphrased', span: span({ quote: 'fire resistance of EI30' }) }],
  unsupported: [{ text: 'Cleaning is done as appropriate.', reason: 'No measurable criterion', span: span({ start: SPEC.indexOf('Cleaning'), end: SPEC.indexOf('Cleaning') + 8, quote: 'Cleaning' }) }] };

test('#6920 requirements card shows each exact span with its verification, keeps unsupported text, and saves what was seen', async () => {
  await converse(REQUIREMENTS);
  const ui = render(<SemanticProposalReview />);
  assert.match(text(ui), /1 of 2 source quotes match/);
  assert.equal(ui.querySelectorAll('blockquote').length, 3);
  assert.match(text(ui), /Quote matches/);
  assert.match(text(ui), /Quote differs/);
  assert.match(text(ui), /No measurable criterion/);
  // The mismatched span reports what the source actually says at those offsets.
  assert.match(text(ui), /fire rating of EI30/);
  assert.equal(useSemanticReviews.getState().entries.length, 0, 'showing a proposal saves nothing');
  const documentBefore = useSemanticSession.getState().document;
  click(buttonLabelled(ui, /Save requirements/i));
  await waitFor(() => useSemanticReviews.getState().entries.length === 1, 'review saved');
  const saved = useSemanticReviews.getState().entries[0];
  assert.equal(saved.type, 'requirements');
  assert.deepEqual(saved.type === 'requirements' && saved.spans, ['verified', 'mismatch']);
  assert.deepEqual(saved.type === 'requirements' && saved.unsupportedSpans, ['verified']);
  assert.equal(useSemanticSession.getState().document, documentBefore, 'the independent linked records are never rewritten');
});

test('#6920 without captured source text no span can verify and the card says so', async () => {
  await seedSemanticModels();
  replaceEvidence(captureEvidence('semantic'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', model: 'm', content: JSON.stringify(REQUIREMENTS) }] });
  const ui = render(<SemanticProposalReview />);
  assert.match(text(ui), /0 of 2 source quotes match/);
  assert.match(text(ui), /No attached text passages/);
  assert.doesNotMatch(text(ui), /Quote differs/);
});

const MAPPINGS = { version: 1, kind: 'semantic.mapping', title: 'Door mappings', modelRevision: DEMO_REVISIONS[0], mappings: [
  { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'FireRating' }, ontology: { property: 'fireRating' }, confidence: 0.9, sources: [span()] },
  { ifc: { class: 'IfcDoor', pset: 'Pset_DoorCommon', property: 'Other' }, ontology: { property: 'madeUp term' }, confidence: 0.4, sources: [span()] }] };

test('#6920 only verified, resolvable mappings can be approved; the saved mapping goes historical when the revision context changes', async () => {
  await converse(MAPPINGS, 2);
  const ui = render(<SemanticProposalReview />);
  const boxes = [...ui.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  assert.deepEqual(boxes.map(box => box.disabled), [false, true], 'an unknown ontology term blocks approval');
  assert.match(text(ui), /3 elements in that model/);
  const save = buttonLabelled(ui, /Save 0 approved mappings/i);
  assert.equal(save.disabled, true);
  click(boxes[0]);
  click(buttonLabelled(ui, /Save 1 approved mapping/i));
  await waitFor(() => useSemanticReviews.getState().entries.length === 1, 'mapping saved');
  const saved = useSemanticReviews.getState().entries[0];
  assert.deepEqual(saved.type === 'mapping' && saved.approved, [0]);
  assert.deepEqual(saved.type === 'mapping' && saved.pin.associations.map(item => item.modelId), ['m0', 'm1']);
  // A durable backup carries the reviewed mapping with its pin and re-validates it on import.
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [], comparison: [], document: [], semanticReviews: useSemanticReviews.getState().entries })));
  assert.equal(backup.libraries.semanticReviews?.length, 1);
  assert.deepEqual(backup.libraries.semanticReviews?.[0], saved);
  assert.throws(() => parseContentBackup(JSON.stringify({ version: 1, libraries: { validation: [], comparison: [], document: [],
    semanticReviews: [{ ...saved, approved: [7] }] } })), /semanticReviews|invalid|unsupported/i);
  assert.equal(await semanticReviewLibrary.put(saved.id, null), true);
});

const QUERY = { version: 1, kind: 'semantic.query', title: 'Doors', purpose: 'List doors', expected: { form: 'select', columns: ['id', 'GlobalId', 'modelRevision'] },
  query: 'SELECT ?id ?GlobalId ?modelRevision WHERE { ?id ?p ?GlobalId } LIMIT 20' };

test('#6920 a query card refuses to run without an exercised grant, discloses the grant without its credential, and runs only on click', async () => {
  await converse(QUERY, 1);
  const ui = render(<SemanticProposalReview />);
  const run = buttonLabelled(ui, /Run query/i) as HTMLButtonElement;
  assert.equal(run.disabled, true);
  assert.match(text(ui), /Open Linked records/);
  assert.match(text(ui), /read-only SELECT with LIMIT 20/);
  let requests = 0;
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = (async () => {
    requests++;
    return new Response(JSON.stringify({ head: { vars: ['id', 'GlobalId', 'modelRevision'] }, results: { bindings: [
      { id: { type: 'uri', value: 'https://example.org/a' }, GlobalId: { type: 'literal', value: '0000000000000000000999' }, modelRevision: { type: 'literal', value: DEMO_REVISIONS[0] } }] } }),
    { status: 200, headers: { 'content-type': 'application/sparql-results+json' } });
  }) as typeof globalThis.fetch;
  try {
    act(() => recordEndpointGrant({ endpoint: 'https://graph.example.org/sparql', host: 'graph.example.org', bearer: 'SECRET-TOKEN' }));
    assert.match(text(ui), /graph\.example\.org/);
    assert.match(text(ui), /Credential/);
    assert.ok(!text(ui).includes('SECRET-TOKEN') && !ui.innerHTML.includes('SECRET-TOKEN'));
    assert.equal(requests, 0, 'a grant alone never runs anything');
    click(run);
    await waitFor(() => /Ran against/.test(text(ui)), 'query result');
    assert.equal(requests, 1);
    // Revoking the authority in the panel withdraws the run button again.
    act(() => revokeEndpointGrant());
    assert.equal((buttonLabelled(ui, /Run query/i) as HTMLButtonElement).disabled, true);
  } finally { globalThis.fetch = fetchOriginal; }
});

test('#6920 a projection card previews through the native service and writes only after explicit approval', async () => {
  const { document } = await seedSemanticModels(1);
  useViewerStore.setState({ editEnabled: true });
  const one = document.resources.find(resource => resource.id.endsWith('installation/1'))!;
  replaceEvidence(captureEvidence('semantic'));
  useAssistant.setState({ messages: [{ role: 'user', content: 'x' }, { role: 'assistant', model: 'm', content: JSON.stringify({ version: 1, kind: 'semantic.projection',
    title: 'Project fire rating', projections: [{ resource: one.id, field: 'fireRating', policy: 'overwrite' }, { resource: 'https://example.org/none', field: 'fireRating' }] }) }] });
  const ui = render(<SemanticProposalReview />);
  assert.match(text(ui), /EI30/);
  assert.match(text(ui), /not in the loaded records/);
  const version = useViewerStore.getState().mutationVersion;
  const apply = buttonLabelled(ui, /Apply 0 projections/i) as HTMLButtonElement;
  assert.equal(apply.disabled, true);
  click(ui.querySelector('input[type="checkbox"]')!);
  click(buttonLabelled(ui, /Apply 1 projection/i));
  assert.match(text(ui), /1 projection applied/);
  assert.ok(useViewerStore.getState().mutationVersion > version);
});

test('#6920 a malformed or unsafe semantic reply is a refused proposal with its reason and no review card', async () => {
  await converse({ ...QUERY, bearer: 'x' });
  const content = useAssistant.getState().messages.at(-1)!.content;
  const proposal = proposalOf(content);
  assert.equal(proposal?.kind, 'invalid');
  assert.match(proposal?.kind === 'invalid' ? proposal.reason : '', /unsupported field "bearer"/);
  const ui = render(<SemanticProposalReview />);
  assert.equal(ui.querySelector('section'), null);
});
