/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #7371: saved validation failure rows are re-examined only through a complete,
 * current, compatible native run. Every run below is the native IDS validator
 * or information-rule runner over the committed SketchUp revision model; edits
 * go through the native mutation view, and the saved side is the bytes the
 * canonical Save/persistence owners actually store.
 */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { act } from 'react';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ValidationReport } from '@ifc-lite/ids';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcParser } from '@ifc-lite/parser';
import { Rule, type RuleSetFile } from '@ifc-lite/rules';
import { useViewerStore } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { revisionPair, runIds, type LoadedModel, type RevisionPair } from '@/lib/compare/revision-pair.test-support';
import { createDataAccessor } from '@/hooks/ids/idsDataAccessor';
import { validateIDS, parseIDS } from '@ifc-lite/ids';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validationReportSnapshot, newSavedReport, savedReportBlock } from '@/lib/validation/reports/history';
import { loadValidationReports } from '@/lib/validation/reports/persistence';
import { runInformationCheck } from '@/lib/validation/run-information-check';
import { createContentBackup, parseContentBackup, importContentBackup } from '@/lib/storage/content-backup';
import { blankDocument } from '@/lib/document/presets';
import { parseDocumentFile } from '@/lib/document/persistence';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { cleanup, click, render, waitFor } from '@/test/render';
import { reviewFindingRow } from '../assistant';
import { cardDescription } from '../bcf-draft';
import { buildCards } from '../cards';
import { reviewDocument } from '../report';
import { captureReviewSnapshot } from '../collect';
import type { ReviewFinding } from '../types';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); act(() => useViewerStore.setState(initial, true)); });

/** The wall the committed demo kit leaves without `IsExternal = true` (see run-reconcile.test.ts). */
const PLUMBING_WALL = '1uS5vfZPn9R8PlAaVd73on';
const SAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'public', 'samples');

const savedFindings = (): ReviewFinding[] => captureReviewSnapshot().findings.filter(row => row.evidence.kind === 'saved-validation');
const savedRuns = () => captureReviewSnapshot().runs.filter(run => run.id.startsWith('["saved-validation"'));
const failingGlobalIds = (report: ValidationReport) =>
  report.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed).map(entity => entity.globalId));

function useModels(...models: LoadedModel[]) {
  useViewerStore.setState({ models: new Map(models.map(model => [model.id, model])), idsValidationReport: null, currentValidationReport: null,
    clashResult: null, clashRawResult: null, compareResult: null, compareReconciliation: null, compareRunCaptures: [], savedComparisons: [] });
}

/** Publish a native report exactly as `useIDS` does: snapshot (scope capture), analysis stamp, store. */
function publish(report: ValidationReport, stamped = true) {
  const snapshot = validationReportSnapshot(report, useViewerStore.getState().models, 'current-run');
  act(() => useViewerStore.getState().setIdsValidationReport(stamped ? stampAnalysisReport(report, captureAnalysisStamp()) : report, snapshot));
}

/** Save a native report through the canonical history owner and return its persisted bytes. */
async function save(report: ValidationReport, name: string) {
  const snapshot = validationReportSnapshot(report, useViewerStore.getState().models, name);
  const entry = newSavedReport(snapshot, name);
  assert.equal(await useViewerStore.getState().saveValidationReportEntry(entry), entry.id);
  const stored = (await loadValidationReports()).find(item => item.id === entry.id);
  assert.ok(stored && stored.snapshot.kind === 'ids-report' && stored.snapshot.elementEvidence);
  return stored;
}

async function savedHeadRun(t: TestContext) {
  const pair = await revisionPair(t); if (!pair) return null;
  useModels(pair.head);
  const baseline = await runIds(pair, 'B');
  assert.ok(failingGlobalIds(baseline).includes(PLUMBING_WALL), 'the real model fails the committed IDS on the plumbing wall');
  const saved = await save(baseline, 'Saved native IDS run');
  return { pair, baseline, saved };
}

const note = (key: string) => ({ labelKey: `reviewWorkspace.reexamination.${key}` });
const findingFor = (globalId: string) => savedFindings().filter(row => row.elements[0]?.globalId === globalId);

test('#7371 a complete compatible native rerun re-examines persisted saved failures: persisting rows and one resolution candidate', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair, baseline, saved } = source;
  assert.ok(savedFindings().every(row => row.lifecycle === 'not-evaluated'), 'without a current run saved rows stay historical');
  const before = structuredClone(saved);

  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  const wall = pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PLUMBING_WALL); assert.ok(wall > 0);
  view.setProperty(wall, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
  const current = await runIds(pair, 'B', { view });
  publish(current);

  const resolved = findingFor(PLUMBING_WALL);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].lifecycle, 'no-longer-observed');
  assert.equal(resolved[0].nativeStatus, 'failed', 'a candidate never rewrites the saved native status');
  assert.deepEqual(resolved[0].notes, [note('resolved')]);
  const others = savedFindings().filter(row => row.elements[0]?.globalId !== PLUMBING_WALL);
  assert.equal(others.length, failingGlobalIds(baseline).length - 1);
  assert.ok(others.every(row => row.lifecycle === 'persistent' && JSON.stringify(row.notes) === JSON.stringify([note('persisting')])));
  assert.ok(savedRuns().every(run => run.temporal === 'historical' && !run.complete
    && run.incomplete.some(gap => gap.message?.labelKey === 'reviewWorkspace.reexamination.compatible')
    && !run.incomplete.some(gap => gap.message?.labelKey === 'reviewWorkspace.reexamination.compatiblePartial')),
    'every saved row was checked again, so the run may say "each"');

  // A candidate stays distinct from a human decision and from native results.
  assert.deepEqual((await loadValidationReports()).find(item => item.id === saved.id), before);
  assert.equal(useViewerStore.getState().idsValidationReport, current);

  // Independent ground truth: the edited model exported to IFC and reparsed fails/passes the same way.
  const step = new StepExporter(pair.head.ifcDataStore, view).export({ schema: 'IFC4', applyMutations: true });
  const reparsed = await new IfcParser().parseColumnar(step.content.slice().buffer, { disableWorkerScan: true });
  const ids = parseIDS(readFileSync(join(SAMPLES, 'building-architecture.ids'), 'utf8'));
  const independent = await validateIDS(ids, createDataAccessor(reparsed, 'B', null),
    { modelId: 'B', schemaVersion: 'IFC4', entityCount: reparsed.entityCount }, { includePassingEntities: true });
  assert.ok(!failingGlobalIds(independent).includes(PLUMBING_WALL), 'the exported IFC no longer fails the plumbing wall');
  assert.deepEqual(failingGlobalIds(independent).sort(), failingGlobalIds(current).sort());

  // Mounted Review: the re-examined wall card is a resolution candidate, the rest stay current findings.
  const ui = render(renderPanelBody('review', () => {}));
  await waitFor(() => ui.querySelectorAll('[data-review-card]').length > 0, 'Review cards');
  const states = [...ui.querySelectorAll('[data-review-card]')].map(card => card.getAttribute('data-card-state'));
  assert.equal(states.filter(state => state === 'resolution-candidate').length, 1);
  assert.ok(!states.includes('not-evaluated'));
});

/** Open every card the way a reviewer does and return what the panel shows. */
async function reviewText(): Promise<string> {
  const ui = render(renderPanelBody('review', () => {}));
  await waitFor(() => ui.querySelectorAll('[data-review-card]').length > 0, 'Review cards');
  // One card is open at a time, so read each card while it is open.
  let text = ui.textContent ?? '';
  const cards = () => [...ui.querySelectorAll('[data-review-card]')];
  for (let index = 0; index < cards().length; index++) {
    const toggle = cards()[index].querySelector('button[aria-expanded="false"]');
    if (toggle) click(toggle);
    text += cards()[index].textContent ?? '';
  }
  cleanup();
  return text;
}
const CODES = /\b(?:noCurrentRun|notEvaluated|definitionDiffers|runIncomplete|entityNotEvaluated|persisting|identityAmbiguous)\b/;

test('#7371 follow-up: Review labels a still-failing saved row against the current run, in plain language', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair } = source;
  const idle = await reviewText();
  assert.ok(idle.includes('Saved failures are historical. No matching current run has checked them again.'), 'the no-current-run sentence is clean');
  assert.doesNotMatch(idle, CODES);

  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  view.setProperty(pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PLUMBING_WALL), 'Pset_WallCommon', 'IsExternal', 'no', PropertyValueType.Label);
  publish(await runIds(pair, 'B', { view }));
  const shown = await reviewText();
  // The saved row IS the earlier run: its counterpart is the current run, never "the earlier run".
  assert.ok(shown.includes('Still in the current run, with different failures'), 'a changed row is told apart');
  assert.ok(shown.includes('The current run still fails this element on the same requirements.'));
  assert.ok(shown.includes('The current run still fails this element, but on different requirements or values.'));
  assert.ok(!shown.includes('Also in the earlier run'));
  assert.doesNotMatch(shown, CODES);
});

test('#7371 changed requirements persist as changed; a capped rerun cannot resolve or see unevaluated rows', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair, baseline } = source;
  const walls = baseline.specificationResults.find(spec => spec.specification.name === 'Walls are external'); assert.ok(walls);
  const target = walls.entityResults.find(entity => entity.globalId === PLUMBING_WALL); assert.ok(target?.globalId && !target.passed);
  assert.equal(target.requirementResults.find(requirement => requirement.status === 'fail')?.actualValue, 'false');
  // Still failing, now with a non-boolean native value instead of the saved `false`.
  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  view.setProperty(target.expressId, 'Pset_WallCommon', 'IsExternal', 'no', PropertyValueType.Label);
  publish(await runIds(pair, 'B', { view }));
  const [changed] = findingFor(target.globalId);
  assert.equal(changed.lifecycle, 'changed', 'different failed requirements stay distinguishable from the same failure');
  assert.deepEqual(changed.notes, [note('changed')]);
  // Assistant evidence, report text and BCF drafts carry the same sentence in English, never the code.
  const row = reviewFindingRow(changed);
  assert.ok(row.detail.includes('The current run still fails this element, but on different requirements or values.'), row.detail.join(' | '));
  assert.ok(row.run.incomplete.includes('partial-source: Only the failed elements were saved. The matching current run checked each of them again.'));

  // A native evaluation cap that still evaluates the corrected wall: an explicit pass, but an incomplete run.
  const position = walls.entityResults.findIndex(entity => entity.globalId === PLUMBING_WALL);
  assert.ok(baseline.specificationResults.some(spec => spec.applicableCount > position + 1), 'a cap can reach the wall without completing the run');
  const fixed = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  fixed.setProperty(target.expressId, 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
  const capped = await runIds(pair, 'B', { maxEntities: position + 1, view: fixed });
  assert.equal(capped.specificationResults.find(spec => spec.specification.id === walls.specification.id)
    ?.entityResults.find(entity => entity.globalId === PLUMBING_WALL)?.passed, true);
  publish(capped);
  const [incomplete] = findingFor(PLUMBING_WALL);
  assert.equal(incomplete.lifecycle, 'not-evaluated', 'an incomplete run never yields a resolution candidate');
  assert.deepEqual(incomplete.notes, [note('runIncomplete')]);
  // A compatible but capped run skipped rows: the run never claims it checked each of them.
  const skipped = savedFindings().filter(row => row.lifecycle === 'not-evaluated').length;
  assert.ok(skipped > 0);
  const partial = (count: number) => savedRuns().every(run => !run.incomplete.some(gap => gap.message?.labelKey === 'reviewWorkspace.reexamination.compatible')
    && run.incomplete.some(gap => gap.message?.labelKey === 'reviewWorkspace.reexamination.compatiblePartial'
      && gap.message.params?.count === count && gap.message.params?.total === savedFindings().length));
  assert.ok(partial(skipped), JSON.stringify(savedRuns().map(run => run.incomplete)));
  assert.ok(reviewFindingRow(incomplete).run.incomplete.some(line => line.includes(`but ${skipped} of ${savedFindings().length} could not be checked`)));
  // A tighter cap leaves saved rows without any current result at all.
  publish(await runIds(pair, 'B', { maxEntities: 1, view: fixed }));
  assert.ok(savedFindings().some(row => row.lifecycle === 'not-evaluated'
    && JSON.stringify(row.notes) === JSON.stringify([note('entityNotEvaluated')])));
});

test('#7371 incompatible, unknown or older evidence stays explicitly not evaluated', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair, saved } = source;
  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  view.setProperty(pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PLUMBING_WALL), 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
  const refused = (reason: string) => {
    assert.ok(savedFindings().every(row => row.lifecycle === 'not-evaluated'), reason);
    assert.ok(savedRuns().some(run => run.incomplete.some(gap => gap.message?.labelKey === `reviewWorkspace.reexamination.${reason}`)), reason);
  };

  publish(await runIds(pair, 'B', { view, edit: xml => xml.replace('name="Walls are external"', 'name="Walls are external (revised)"') }));
  refused('definitionDiffers');
  publish(await runIds(pair, 'B', { view }), false);
  refused('runFreshnessUnknown');
  publish(await runIds(pair, 'B', { view }));
  act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
  refused('runStale');

  // The same file name loaded from a different source is a changed scope.
  useModels({ ...pair.head, sourceFingerprint: 'another-source-7371' });
  publish(await runIds(pair, 'B', { view }));
  refused('scopeDiffers');

  // An older snapshot without the recorded definition cannot be re-examined.
  useModels(pair.head);
  const older = structuredClone(saved);
  if (older.snapshot.kind !== 'ids-report' || !older.snapshot.elementEvidence) assert.fail();
  delete older.snapshot.elementEvidence.definition;
  for (const row of older.snapshot.elementEvidence.rows) delete row.signature;
  await act(async () => { await useViewerStore.getState().removeValidationReport(saved.id); });
  assert.ok(await useViewerStore.getState().saveValidationReportEntry(newSavedReport(older.snapshot, 'Older saved run')));
  publish(await runIds(pair, 'B', { view }));
  refused('definitionNotRecorded');
});

/** What the report text and the BCF description of the plumbing wall's saved card say. */
function exportedText(): { report: string; bcf: string } {
  const { cards, totals } = buildCards(savedFindings(), []);
  const card = cards.find(item => item.findings.some(row => row.elements[0]?.globalId === PLUMBING_WALL)); assert.ok(card);
  const document = reviewDocument('R', [card], totals, { version: 1, id: 'w', name: 'w', decisions: [] });
  return { report: document.blocks.map(block => block.kind === 'text' ? block.text : '').join('\n'), bcf: cardDescription(card) };
}

test('#7371 follow-up: report text and BCF descriptions say why a saved failure was not checked again', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair } = source;
  const historical = 'Saved failures are historical. No matching current run has checked them again.';
  const idle = exportedText();
  assert.ok(idle.report.includes(historical), 'no current run: report');
  assert.ok(idle.bcf.includes(historical), 'no current run: BCF description');

  publish(await runIds(pair, 'B', { edit: xml => xml.replace('name="Walls are external"', 'name="Walls are external (revised)"') }));
  const edited = exportedText();
  const differs = 'Not checked again: the current run used different or edited checks.';
  for (const text of [edited.report, edited.bcf]) {
    assert.ok(text.includes(historical) && text.includes(differs), text);
    assert.doesNotMatch(text, /definitionDiffers|noCurrentRun/);
  }
});

test('#7371 recorded definitions survive document copies and backup import, and copies re-examine identically', async t => {
  const source = await savedHeadRun(t); if (!source) return;
  const { pair, saved } = source;
  if (saved.snapshot.kind !== 'ids-report') assert.fail();
  const definition = saved.snapshot.elementEvidence?.definition;
  assert.ok(definition && definition.checks.length === 3 && saved.snapshot.elementEvidence?.rows.every(row => row.signature));
  const document = blankDocument(); document.blocks = [savedReportBlock(saved, 'reexamined-document')];
  const parsed = parseDocumentFile(JSON.stringify(document)).blocks[0];
  assert.ok(parsed.kind === 'ids-report'); assert.deepEqual(parsed.elementEvidence, saved.snapshot.elementEvidence);
  const copy = structuredClone(saved); copy.snapshot.generatedAt = '2026-10-11T00:00:00.000Z';
  assert.ok(await importContentBackup(parseContentBackup(JSON.stringify(createContentBackup({ validation: [copy], document: [], comparison: [] })))));
  await useViewerStore.getState().refreshValidationReports();
  const all = await loadValidationReports(); assert.equal(all.length, 2);
  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  view.setProperty(pair.head.ifcDataStore.entities.getExpressIdByGlobalId(PLUMBING_WALL), 'Pset_WallCommon', 'IsExternal', true, PropertyValueType.Boolean);
  publish(await runIds(pair, 'B', { view }));
  const byReport = new Map<string, string[]>();
  for (const row of savedFindings()) if (row.evidence.kind === 'saved-validation') {
    byReport.set(row.evidence.reportId, [...(byReport.get(row.evidence.reportId) ?? []), `${row.elements[0]?.globalId}:${row.lifecycle}`]);
  }
  assert.equal(byReport.size, 2);
  const [first, second] = [...byReport.values()];
  assert.deepEqual(first, second);
  assert.ok(first.includes(`${PLUMBING_WALL}:no-longer-observed`));
});

const wallsNamed: RuleSetFile = { version: 1, name: '#7371 wall naming', rules: [{ id: 'named-wall', name: 'Walls are named',
  applicability: { groups: [{ rules: [Rule.ifcType(['IfcWall'])], combinator: 'AND' }], authoredAs: 'chips' },
  requirement: { kind: 'element', block: { groups: [{ rules: [Rule.attribute('Name', 'eq', 'reexamined-7371')], combinator: 'AND' }], authoredAs: 'chips' } },
}] };

async function rulesRun(pair: RevisionPair, ruleSet: RuleSetFile, views: Partial<Record<'A' | 'B', MutablePropertyView>> = {}) {
  const models = [pair.base, pair.head];
  const { report } = await runInformationCheck({ ruleSet,
    models: models.map(model => ({ id: model.id, filterIdentity: model.sourceFingerprint, store: model.ifcDataStore,
      ...(views[model.id as 'A' | 'B'] ? { mutationView: views[model.id as 'A' | 'B'] } : {}) })),
    reportModels: useViewerStore.getState().models });
  return report;
}

test('#7371 an N-model information-rule run keeps shared GlobalIds separated by their own model source', async t => {
  const pair = await revisionPair(t); if (!pair) return;
  useModels(pair.base, pair.head);
  const baseline = await rulesRun(pair, wallsNamed);
  const shared = failingGlobalIds(baseline).find((id, index, all) => all.indexOf(id) !== index);
  assert.ok(shared, 'the revision pair preserves wall GlobalIds across both models');
  await save(baseline, 'Saved federated rule run');
  const view = new MutablePropertyView(pair.head.ifcDataStore.properties, 'B');
  view.setAttribute(pair.head.ifcDataStore.entities.getExpressIdByGlobalId(shared), 'Name', 'reexamined-7371');
  publish(await rulesRun(pair, wallsNamed, { B: view }));
  const rows = findingFor(shared);
  assert.deepEqual(rows.map(row => [row.elements[0].modelName, row.lifecycle]).sort(),
    [[pair.base.name, 'persistent'], [pair.head.name, 'no-longer-observed']].sort());
  assert.ok(rows.every(row => row.elements[0].modelId === null), 'historical rows never install runtime model ids');

  // Edited rule content under the same rule-set name and rule id is a different definition.
  publish(await rulesRun(pair, { ...wallsNamed, rules: wallsNamed.rules.map(rule => ({ ...rule, name: 'Walls are named (edited)' })) }, { B: view }));
  assert.ok(savedFindings().every(row => row.lifecycle === 'not-evaluated'));
});
