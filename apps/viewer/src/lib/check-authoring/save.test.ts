/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseIDS } from '@ifc-lite/ids';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { SAMPLE_IDS_PROPOSAL, SAMPLE_RULES_PROPOSAL, json } from '@/test/check-authoring-fixture';
import { loadDefinitionLibrary } from '../validation/definition-library';
import { useValidationSourceChoice } from '../validation/validation-source-choice';
import { loadDocuments } from '../document/persistence';
import { auditIdsDraft, buildIdsDraft, parseIdsProposal } from './ids-proposal';
import { parseRulesProposal } from './rules-proposal';
import { parseDocumentOutline, prepareDocumentDraft } from './document-outline';
import { dryRunIds, dryRunRules } from './dry-run';
import { openDefinition, saveDocumentDraft, saveIdsDraft, saveRulesDraft } from './save';

const initial = useViewerStore.getState();
afterEach(() => { useViewerStore.setState(initial, true); localStorage.clear(); useValidationSourceChoice.setState({ choice: null }); });

const IDS_WITH_UNSUPPORTED = { ...SAMPLE_IDS_PROPOSAL, unsupported: [{ text: 'Spaces have daylight', reason: 'needs a daylight simulation', relatesTo: 'Spaces are named' }] };

// #6915: saved drafts reopen through the native library parsers with their unsupported requirements.
test('an audited, dry-run IDS draft saves into the native library and reopens with its unsupported requirements', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const draft = buildIdsDraft(parseIdsProposal(json(IDS_WITH_UNSUPPORTED)));
  const issues = await auditIdsDraft(draft);
  assert.throws(() => saveIdsDraft(draft, issues, null), /Dry-run the draft/);
  assert.throws(() => saveIdsDraft(draft, null, null), /audit errors/);
  const run = await dryRunIds(draft.document);
  const saved = saveIdsDraft(draft, issues, run);
  const reopened = loadDefinitionLibrary();
  assert.equal(reopened.error, null);
  const entry = reopened.library.entries.find(candidate => candidate.id === saved.id);
  assert.ok(entry && entry.kind === 'ids');
  assert.equal(entry.xml, draft.xml, 'the exact reviewed XML is stored');
  assert.deepEqual(entry.document.specifications.map(spec => spec.name), SAMPLE_IDS_PROPOSAL.specifications.map(spec => spec.name));
  assert.match(entry.document.info.description ?? '', /Spaces have daylight \(needs a daylight simulation; Spaces are named\)/);
  assert.match(parseIDS(entry.xml).specifications[0].instructions ?? '', /Spaces have daylight/);
  assert.equal(reopened.library.active.ids, saved.id);
  assert.equal(useViewerStore.getState().idsDocument?.info.title, 'Building Architecture IDS', 'it is the active native IDS');
  openDefinition('ids', saved.id);
  assert.equal(useValidationSourceChoice.getState().choice, 'ids');
});

test('dry-run rules save as a native rule set that reopens in the rule editor', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const proposal = parseRulesProposal(json(SAMPLE_RULES_PROPOSAL));
  assert.throws(() => saveRulesDraft(proposal, null), /Dry-run the rules/);
  const run = await dryRunRules(proposal.ruleSet);
  const edited = { ...proposal, ruleSet: { ...proposal.ruleSet, name: 'Edited after the run' } };
  assert.throws(() => saveRulesDraft(edited, run), /Dry-run the rules/, 'an edit after the dry run needs a new run');
  const saved = saveRulesDraft(proposal, run);
  const entry = loadDefinitionLibrary().library.entries.find(candidate => candidate.id === saved.id);
  assert.ok(entry && entry.kind === 'rules');
  const reparsed = parseRuleSetFile(JSON.parse(JSON.stringify(entry.file)));
  assert.ok(reparsed.ok);
  assert.deepEqual(reparsed.file.rules.map(rule => rule.id), ['wall-fire-rating', 'wall-names-unique']);
  assert.match(reparsed.file.description ?? '', /53 dB airborne sound insulation/);
  openDefinition('rules', saved.id);
  const state = useViewerStore.getState();
  assert.equal(state.validationRuleSetEditing, true);
  assert.equal(state.validationRuleSetDraft?.name, 'Wall information');
  assert.equal(useValidationSourceChoice.getState().choice, 'rules');
});

test('an outline saves as a new native document bound to the live report; a replaced report needs a new draft', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const draft = buildIdsDraft(parseIdsProposal(json(SAMPLE_IDS_PROPOSAL)));
  const { runIdsCheck } = await import('../validation/run-ids-check');
  const state = useViewerStore.getState();
  const { report } = await runIdsCheck({ document: draft.document, modelId: 'arch', dataStore: state.models.get('arch')!.ifcDataStore!, locale: 'en', models: state.models });
  useViewerStore.setState({ idsValidationReport: report });
  const outline = parseDocumentOutline(json({ version: 1, kind: 'document.outline', title: 'Walls', sections: [{ heading: 'Failures',
    blocks: [{ kind: 'validationTable', specification: 'spec-1', rows: 'failed', columns: ['name', 'reason'] }] }] }));
  const prepared = prepareDocumentDraft(outline, report);
  assert.equal(await saveDocumentDraft(prepared), true);
  const stored = (await loadDocuments()).find(document => document.id === prepared.document.id);
  assert.ok(stored);
  assert.deepEqual(stored.blocks.find(block => block.kind === 'table'), prepared.document.blocks.find(block => block.kind === 'table'));
  useViewerStore.setState({ idsValidationReport: { ...report, timestamp: new Date() } });
  await assert.rejects(saveDocumentDraft(prepareDocumentDraft(outline, report)), /report changed/);
});
