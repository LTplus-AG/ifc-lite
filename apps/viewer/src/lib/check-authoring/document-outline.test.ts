/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseIDS } from '@ifc-lite/ids';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { SAMPLE_MODEL, seedAuthoringSample } from '@/test/authoring-sample-fixture';
import { SAMPLE_IDS_XML, json } from '@/test/check-authoring-fixture';
import { runIdsCheck } from '../validation/run-ids-check';
import { resolveValidationTableState } from '../document/resolve-validation-table';
import { templatePaths } from '../document/bindings';
import type { TableBlock } from '../document/types';
import { parseDocumentOutline, prepareDocumentDraft } from './document-outline';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));

async function sampleReport() {
  const state = useViewerStore.getState();
  const { report } = await runIdsCheck({ document: parseIDS(SAMPLE_IDS_XML), modelId: SAMPLE_MODEL, dataStore: state.models.get(SAMPLE_MODEL)!.ifcDataStore!,
    mutationView: state.getMutationView(SAMPLE_MODEL), locale: 'en', models: state.models });
  return report;
}

const OUTLINE = { version: 1, kind: 'document.outline', title: 'Wall check {Model.Name}', sections: [
  { heading: 'Summary', purpose: 'summary', blocks: [{ kind: 'text', text: 'Walls must declare whether they are external.' }, { kind: 'validationSummary' }] },
  { heading: 'Findings', purpose: 'findings', blocks: [{ kind: 'validationTable', specification: 'spec-1', rows: 'failed', columns: ['name', 'globalId', 'reason'] }] },
], unsupported: [{ text: 'Wall finishes match the sample board', reason: 'manual inspection' }] };

// #6915: a table is bound to the live native report, not filled with values the assistant wrote.
test('an outline validation table resolves against whichever report is current, after a real model edit', async () => {
  const { view } = await seedAuthoringSample({ editEnabled: false });
  const before = await sampleReport();
  useViewerStore.setState({ idsValidationReport: before });
  const draft = prepareDocumentDraft(parseDocumentOutline(json(OUTLINE)), before);
  const table = draft.document.blocks.find((block): block is TableBlock => block.kind === 'table')!;
  assert.deepEqual(table.source, { kind: 'validation', rows: 'failed', columns: ['name', 'globalId', 'reason'], ruleId: 'spec-1' });
  const failing = before.specificationResults[1].entityResults.filter(entity => !entity.passed);
  assert.ok(failing.length > 0, 'the sample has walls failing "Walls are external"');
  const rows = (report: typeof before) => {
    const state = resolveValidationTableState(table.source.kind === 'validation' ? table.source : { kind: 'validation', rows: 'all', columns: ['name'] }, report, id => id);
    return state.status === 'ok' && state.kind === 'validation' ? state.model.totalRows : -1;
  };
  assert.equal(rows(before), failing.length);
  // Correct one wall natively; the same saved block now prints the new run's rows.
  view.setProperty(failing[0].expressId, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean, undefined, false, 'IFCBOOLEAN');
  const after = await sampleReport();
  assert.equal(rows(after), failing.length - 1);
  assert.equal(resolveValidationTableState({ kind: 'validation', rows: 'failed', columns: ['name'], ruleId: 'spec-1' }, null, id => id).status, 'no-report');
  const summary = draft.document.blocks.find(block => block.kind === 'ids-report');
  assert.ok(summary && summary.kind === 'ids-report' && summary.checks[1].failed === failing.length, 'the summary is the native report snapshot');
  const texts = draft.document.blocks.filter(block => block.kind === 'text');
  assert.ok(texts.every(block => block.kind === 'text' && templatePaths(block.text).length === 0), 'drafted text never becomes a model binding');
  assert.match(texts.map(block => block.kind === 'text' ? block.text : '').join('\n'), /Wall finishes match the sample board \(manual inspection\)/);
});

test('outline refusals: written values, unknown specifications and summaries without a report', async () => {
  await seedAuthoringSample({ editEnabled: false });
  const report = await sampleReport();
  const outline = (blocks: unknown[]) => json({ ...OUTLINE, sections: [{ heading: 'Findings', blocks }] });
  assert.throws(() => parseDocumentOutline(outline([{ kind: 'number', value: 12 }])), /values come from native blocks, not written numbers/);
  assert.throws(() => parseDocumentOutline(outline([{ kind: 'validationTable', rows: 'failed', columns: ['cost'] }])), /columns must list columns from/);
  assert.throws(() => prepareDocumentDraft(parseDocumentOutline(outline([{ kind: 'validationTable', specification: 'spec-9', rows: 'failed', columns: ['name'] }])), report),
    /specification "spec-9" is not in the current report; use one of spec-0, spec-1, spec-2/);
  assert.throws(() => prepareDocumentDraft(parseDocumentOutline(outline([{ kind: 'validationSummary' }])), null), /needs a current validation report/);
  assert.doesNotThrow(() => prepareDocumentDraft(parseDocumentOutline(outline([{ kind: 'validationTable', rows: 'all', columns: ['name'] }])), null),
    'an unbound table may wait for a report');
});
