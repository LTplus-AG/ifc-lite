/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { act } from 'react';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { createValidationReportsSlice } from '@/store/slices/validationReportsSlice';
import { useViewerStore } from '@/store';
import { revisionPair, runIds, runRules } from '@/lib/compare/revision-pair.test-support';
import { validationReportSnapshot, newSavedReport, savedReportBlock, validateSavedReport } from '@/lib/validation/reports/history';
import { loadValidationReports } from '@/lib/validation/reports/persistence';
import { SavedValidationReports } from '@/components/viewer/validation/SavedValidationReports';
import { SaveValidationReportButton } from '@/components/viewer/validation/SaveValidationReportButton';
import { createContentBackup, parseContentBackup, importContentBackup } from '@/lib/storage/content-backup';
import { blankDocument } from '@/lib/document/presets';
import { parseDocumentFile } from '@/lib/document/persistence';
import * as evidenceFocus from '@/lib/panels/evidence-focus';
import { render, cleanup, click, advance, waitFor } from '@/test/render';
import { captureReviewSnapshot, reviewModel } from '../collect';
import { validationFindings } from './validation';
import { idsReportBlockFromReport } from '@/lib/document/ids-report';
import { useReviewSnapshot } from '@/components/viewer/review/useReviewSnapshot';
import { openOriginal } from '../open';
import { pinReviewCard } from '../assistant';
import { useReviewAssistantCard } from '../assistant-state';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); act(() => { useViewerStore.setState(initial, true); evidenceFocus.useSavedValidationFocus?.setState({ record: null }); }); });
const savedFindings = () => captureReviewSnapshot().findings.filter(row => row.evidence.kind === 'saved-validation');
const rules: RuleSetFile = { version: 1, name: '#7091 native wall naming', rules: [{ id: 'named-wall', name: 'Walls are named',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Name', 'eq', 'not-authored-7091')], combinator: 'AND' }], authoredAs: 'chips' } },
}] };
async function checked(t: TestContext, kind: 'ids' | 'rules' = 'ids') {
  const pair = await revisionPair(t); if (!pair) return null;
  useViewerStore.setState({ models: new Map([['B', pair.head]]), idsValidationReport: null, clashResult: null, clashRawResult: null,
    compareResult: null, compareReconciliation: null, compareRunCaptures: [], savedComparisons: [], currentValidationReport: null });
  const report = kind === 'ids' ? await runIds(pair, 'B') : await runRules(pair, 'B', rules);
  const failures = report.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed));
  assert.ok(failures.length > 0, 'the real model fails the native authored check');
  const snapshot = validationReportSnapshot(report, useViewerStore.getState().models, 'native-run');
  assert.ok(snapshot.elementEvidence);
  return { pair, report, snapshot, failures };
}

for (const kind of ['ids', 'rules'] as const) test(`#7091 native ${kind} Save retains exact IFC failure evidence through durable reload`, async t => {
  const source = await checked(t, kind); if (!source) return;
  act(() => useViewerStore.getState().setIdsValidationReport(source.report, source.snapshot));
  const ui = render(<SaveValidationReportButton report={source.report} />);
  const save = [...ui.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Save report'); assert.ok(save); click(save);
  await waitFor(() => useViewerStore.getState().savedValidationReports.length === 1 && Object.values(useViewerStore.getState().validationReportsStorage.items).includes('saved'), 'real native Save transaction');
  const [stored] = await loadValidationReports(); assert.ok(stored); assert.equal(stored.snapshot.kind, 'ids-report');
  if (stored.snapshot.kind !== 'ids-report') assert.fail();
  assert.ok(stored.snapshot.elementEvidence);
  assert.equal(stored.snapshot.elementEvidence.rows.length, source.failures.length);
  for (const [index, row] of stored.snapshot.elementEvidence.rows.entries()) {
    assert.equal(row.GlobalId, source.failures[index].globalId);
    assert.equal(row.modelName, source.pair.head.name);
    assert.ok(source.pair.head.ifcDataStore.entities.getExpressIdByGlobalId(row.GlobalId ?? '') > 0);
    assert.equal(row.Name, source.failures[index].entityName);
  }
  const portable = JSON.parse(JSON.stringify(stored.snapshot.elementEvidence));
  assert.ok(portable.rows.every((row: Record<string, unknown>) => !('modelId' in row) && !('expressId' in row) && !('globalId' in row)));
  act(() => { useViewerStore.getState().clearIdsValidationReport(); useViewerStore.setState({ models: new Map() }); });
  const rows = savedFindings(); assert.equal(rows.length, source.failures.length);
  assert.ok(rows.every(row => row.run.temporal === 'historical' && row.lifecycle === 'not-evaluated' && !row.run.complete));
  assert.ok(rows.every(row => row.elements.every(element => element.modelId === null)));
});

test('#7091 older count-only snapshots remain valid and cannot invent historical findings', async t => {
  const source = await checked(t); if (!source) return;
  const legacy = structuredClone(source.snapshot); delete legacy.elementEvidence;
  const saved = newSavedReport(legacy, 'Older native report'); assert.ok(validateSavedReport(saved));
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  assert.deepEqual(savedFindings(), []);
  assert.ok(captureReviewSnapshot().runs.some(run => run.incomplete.some(gap => gap.detail?.includes('older count-only'))));
});

test('#7091 missing native GlobalIds resolve only against the original evaluated model and survive scene removal', async t => {
  const source = await checked(t); if (!source) return;
  const report = structuredClone(source.report);
  for (const spec of report.specificationResults) for (const entity of spec.entityResults) delete entity.globalId;
  const models = useViewerStore.getState().models;
  const live = validationFindings({ report, stale: false }, [reviewModel('B', source.pair.head.name, source.pair.head.ifcDataStore)]);
  assert.equal(live.findings.length, source.failures.length);
  assert.ok(live.findings.every(finding => finding.elements.length === 1));
  const snapshot = validationReportSnapshot(report, models, 'resolved-native-evidence');
  assert.deepEqual(snapshot.elementEvidence?.rows.map(row => row.GlobalId), live.findings.map(finding => finding.elements[0].globalId));
  const saved = newSavedReport(snapshot);
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  act(() => useViewerStore.setState({ models: new Map() }));
  assert.deepEqual(idsReportBlockFromReport(report, 'later-document').elementEvidence, snapshot.elementEvidence);
  assert.deepEqual(validationReportSnapshot(report, new Map(), 'later-save').elementEvidence, snapshot.elementEvidence);
  const [persisted] = await loadValidationReports(); assert.equal(persisted.snapshot.kind, 'ids-report');
  if (persisted.snapshot.kind !== 'ids-report') assert.fail();
  assert.deepEqual(persisted.snapshot.elementEvidence, snapshot.elementEvidence);
  const unresolved = structuredClone(report);
  for (const spec of unresolved.specificationResults) for (const entity of spec.entityResults) entity.modelId = 'unloaded-source';
  const unknown = validationReportSnapshot(unresolved, models, 'unknown-model');
  assert.ok(unknown.elementEvidence?.rows.length);
  assert.ok(unknown.elementEvidence.rows.every(row => row.GlobalId === null && row.modelName === null), 'never borrow matching express ids from another model');
});

test('#7091 exact historical original reopens a collapsed native history without installing old scene ids', async t => {
  const source = await checked(t); if (!source) return;
  const first = newSavedReport(source.snapshot, 'First native evidence');
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(first), first.id);
  const later = newSavedReport(source.snapshot, 'Later native evidence');
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(later), later.id);
  const finding = savedFindings().find(row => row.evidence.kind === 'saved-validation' && row.evidence.reportId === first.id); assert.ok(finding);
  const ui = render(<SavedValidationReports />); const panels: string[] = [];
  act(() => { assert.equal(openOriginal(finding, panel => panels.push(panel)), true); });
  await waitFor(() => ui.querySelector('[aria-current="true"]') !== null, 'saved native failure original');
  assert.deepEqual(panels, ['validation']);
  assert.equal(ui.querySelector<HTMLSelectElement>('select')?.value, first.id);
  assert.equal(document.activeElement, ui.querySelector('[aria-current="true"]'));
  const history = ui.querySelector<HTMLDetailsElement>('[data-saved-validation-reports]'); assert.ok(history?.open);
  act(() => { history.open = false; history.dispatchEvent(new window.Event('toggle')); });
  const away = document.createElement('button'); ui.append(away); away.focus();
  act(() => { assert.equal(openOriginal(finding, panel => panels.push(panel)), true); });
  await waitFor(() => history.open && document.activeElement === ui.querySelector('[aria-current="true"]'), 'repeated saved original reopens and refocuses');
  assert.deepEqual([...useViewerStore.getState().selectedEntityIds], []);
  await act(async () => { assert.ok(await useViewerStore.getState().removeValidationReport(first.id)); });
  assert.equal(openOriginal(finding, () => assert.fail('deleted original cannot open')), false);
  assert.equal(evidenceFocus.useSavedValidationFocus.getState().record, null);
});

test('#7091 persisted native history changes refresh Review and clear pinned saved evidence', async t => {
  const source = await checked(t); if (!source) return;
  const saved = newSavedReport(source.snapshot);
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  function HistoryCount() { const { snapshot } = useReviewSnapshot(); return <output>{snapshot.findings.filter(row => row.evidence.kind === 'saved-validation').length}</output>; }
  const ui = render(<HistoryCount />); assert.equal(ui.textContent, String(source.failures.length));
  const card = captureReviewSnapshot().cards.find(card => card.findings.some(row => row.evidence.kind === 'saved-validation')); assert.ok(card); pinReviewCard(card, null);
  await act(async () => { assert.ok(await useViewerStore.getState().removeValidationReport(saved.id)); }); await advance(0);
  assert.equal(ui.textContent, '0'); assert.equal(useReviewAssistantCard.getState().card, null);
});

test('#7091 document copies and reidentified backup conflicts preserve immutable native failure facts', async t => {
  const source = await checked(t); if (!source) return;
  const saved = newSavedReport(source.snapshot);
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  const document = blankDocument(); document.blocks = [savedReportBlock(saved, 'native-failure-document')];
  const parsed = parseDocumentFile(JSON.stringify(document));
  assert.equal(parsed.blocks[0].kind, 'ids-report');
  if (parsed.blocks[0].kind !== 'ids-report') assert.fail();
  assert.deepEqual(parsed.blocks[0].elementEvidence, source.snapshot.elementEvidence);
  const conflicting = structuredClone(saved); conflicting.snapshot.generatedAt = '2026-10-08T00:00:00.000Z';
  const backup = parseContentBackup(JSON.stringify(createContentBackup({ validation: [conflicting], document: [], comparison: [] })));
  assert.ok(await importContentBackup(backup));
  await useViewerStore.getState().refreshValidationReports();
  const all = await loadValidationReports(); assert.equal(all.length, 2);
  const copy = all.find(entry => entry.id !== saved.id); assert.ok(copy);
  assert.equal(copy.snapshot.kind, 'ids-report'); if (copy.snapshot.kind !== 'ids-report') assert.fail();
  assert.deepEqual(copy.snapshot.elementEvidence, source.snapshot.elementEvidence);
  assert.ok(savedFindings().some(row => row.evidence.kind === 'saved-validation' && row.evidence.reportId === copy.id));
});


test('#7091 native failure captures bound row work and explicitly report omitted or unscanned evidence', async t => {
  const source = await checked(t, 'rules'); if (!source) return;
  const nativeSpec = source.report.specificationResults.find(spec => spec.entityResults.some(entity => !entity.passed)); assert.ok(nativeSpec);
  const nativeFailure = nativeSpec.entityResults.find(entity => !entity.passed); assert.ok(nativeFailure);
  // Invariant: a large report containing repeated real native failure facts has bounded portable evidence.
  const expanded = { ...source.report, specificationResults: [{ ...nativeSpec,
    entityResults: Array.from({ length: 50_001 }, () => nativeFailure), failedCount: 50_001, applicableCount: 50_001,
  }] };
  const snapshot = validationReportSnapshot(expanded, useViewerStore.getState().models, 'large-native-evidence');
  assert.ok(snapshot.elementEvidence);
  assert.ok(snapshot.elementEvidence.rows.length <= 2_000);
  assert.equal(snapshot.elementEvidence.observed, 50_000);
  assert.equal(snapshot.elementEvidence.observed, snapshot.elementEvidence.rows.length + snapshot.elementEvidence.omitted);
  assert.ok(snapshot.elementEvidence.omitted > 0);
  assert.ok(snapshot.elementEvidence.gaps.some(gap => gap.includes('remaining failure count is unknown')));
  assert.ok(snapshot.elementEvidence.gaps.some(gap => gap.includes('rows exceeding')));
  assert.ok(new TextEncoder().encode(JSON.stringify(snapshot.elementEvidence)).byteLength <= 1_048_576);
  const saved = newSavedReport(snapshot); assert.ok(validateSavedReport(saved));
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  const last = snapshot.elementEvidence.rows.at(-1); assert.ok(last);
  const finding = savedFindings().find(row => row.evidence.kind === 'saved-validation' && row.evidence.rowId === last.id); assert.ok(finding);
  assert.equal(openOriginal(finding, () => {}), true);
  const ui = render(<SavedValidationReports />);
  await waitFor(() => ui.querySelector('[aria-current="true"]')?.getAttribute('data-saved-validation-row') === last.id, 'bounded native history includes the exact original beyond its first 50 rows');
  assert.equal(ui.querySelectorAll('[data-saved-validation-row]').length, 50);
  assert.equal(document.activeElement, ui.querySelector('[aria-current="true"]'));
});

test('#7091 portable validators reject ephemeral ids, aliases and contradictory native evidence counts', async t => {
  const source = await checked(t); if (!source) return;
  const saved = newSavedReport(source.snapshot);
  assert.equal(saved.snapshot.kind, 'ids-report'); if (saved.snapshot.kind !== 'ids-report') assert.fail();
  assert.ok(saved.snapshot.elementEvidence?.rows.length);
  for (const extra of [{ expressId: 42 }, { modelId: 'runtime-only' }, { globalId: 'invented-alias' }]) {
    const changed = structuredClone(saved);
    if (changed.snapshot.kind !== 'ids-report') assert.fail();
    Object.assign(changed.snapshot.elementEvidence!.rows[0], extra);
    assert.equal(validateSavedReport(changed), false);
  }
  const contradictory = structuredClone(saved);
  if (contradictory.snapshot.kind !== 'ids-report') assert.fail();
  contradictory.snapshot.elementEvidence!.observed++;
  assert.equal(validateSavedReport(contradictory), false);
});


test('#7091 Review alone hydrates a cold native history controller without visiting Validation', async t => {
  const source = await checked(t); if (!source) return;
  const saved = newSavedReport(source.snapshot);
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(saved), saved.id);
  const [finding] = savedFindings(); assert.ok(finding);
  // A fresh native controller has no hydrated rows; committed IndexedDB evidence remains intact.
  useViewerStore.setState(createValidationReportsSlice(useViewerStore.setState, useViewerStore.getState, useViewerStore));
  assert.equal(openOriginal(finding, () => assert.fail('pending historical reads cannot open an original')), false);
  assert.ok(captureReviewSnapshot().runs.some(run => run.incomplete.some(gap => gap.detail === 'Saved validation library loading')));
  function ColdHistory() { const { snapshot } = useReviewSnapshot(); return <output>{snapshot.findings.filter(row => row.evidence.kind === 'saved-validation').length}</output>; }
  const ui = render(<ColdHistory />);
  await waitFor(() => ui.textContent === String(source.failures.length), 'Review independently hydrates actual saved failure evidence');
  assert.equal(useViewerStore.getState().validationReportsStorage.phase, 'ready');
  assert.ok(captureReviewSnapshot().runs.every(run => !run.incomplete.some(gap => gap.detail === 'Saved validation library loading')));
});


test('#7091 native warning severity survives saved evidence and historical Review', async t => {
  const source = await checked(t, 'rules'); if (!source) return;
  const warningRules = { ...rules, rules: rules.rules.map(rule => ({ ...rule, severity: 'warning' as const })) };
  const report = await runRules(source.pair, 'B', warningRules);
  const snapshot = validationReportSnapshot(report, useViewerStore.getState().models, 'native-warning');
  assert.ok(snapshot.elementEvidence?.rows.length);
  assert.ok(snapshot.elementEvidence.rows.every(row => row.nativeStatus === 'warning'));
  assert.ok(await useViewerStore.getState().saveValidationReportEntry(newSavedReport(snapshot)));
  const findings = savedFindings();
  assert.equal(findings.length, snapshot.elementEvidence.rows.length);
  assert.ok(findings.length > 0, 'native warnings must appear in historical Review');
  assert.ok(findings.every(row => row.nativeStatus === 'warning' && row.lifecycle === 'not-evaluated'));
});


test('#7091 a real capped native IDS evaluation discloses unevaluated applicability in saved history', async t => {
  const source = await checked(t); if (!source) return;
  const report = await runIds(source.pair, 'B', { maxEntities: 1 });
  assert.ok(report.specificationResults.some(spec => spec.passedCount + spec.failedCount < spec.applicableCount));
  const snapshot = validationReportSnapshot(report, useViewerStore.getState().models, 'capped-native-ids');
  assert.ok(snapshot.elementEvidence?.gaps.some(gap => gap.includes('smaller than its applicable population')));
  assert.ok(await useViewerStore.getState().saveValidationReportEntry(newSavedReport(snapshot)));
  const findings = savedFindings();
  assert.equal(findings.length, snapshot.elementEvidence?.rows.length);
  assert.ok(findings.every(row => row.lifecycle === 'not-evaluated' && !row.run.complete));
  assert.ok(captureReviewSnapshot().runs.some(run => run.temporal === 'historical'
    && run.incomplete.some(gap => gap.detail?.includes('smaller than its applicable population'))));
});
