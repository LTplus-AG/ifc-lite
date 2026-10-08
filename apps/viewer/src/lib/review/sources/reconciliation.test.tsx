/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import 'fake-indexeddb/auto';
import { act } from 'react';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import { useViewerStore } from '@/store';
import { revisionPair, runIds, runClash } from '@/lib/compare/revision-pair.test-support';
import { savedReconciliationOf } from '@/lib/compare/compare-reconcile-state';
import type { CapturedRun } from '@/lib/compare/run-reconcile-types';
import { captureReviewSnapshot } from '../collect';
import { pinReviewCard } from '../assistant';
import { useReviewAssistantCard } from '../assistant-state';
import { openOriginal } from '../open';
import { captureEvidence } from '@/lib/assistant/evidence';
import * as evidenceFocus from '@/lib/panels/evidence-focus';
import { useReviewSnapshot } from '@/components/viewer/review/useReviewSnapshot';
import { CompareReconcileSection } from '@/components/viewer/compare/CompareReconcileSection';
import { cleanup, render, waitFor, advance } from '@/test/render';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); act(() => { useViewerStore.setState(initial, true); evidenceFocus.useReconciliationFocus?.setState({ record: null }); }); });
const run = (id: string, report: Awaited<ReturnType<typeof runIds>>): CapturedRun => ({
  id, kind: 'validation', report, capturedAt: '2026-10-08T00:00:00.000Z', modelIds: report.modelInfo.map(model => model.modelId),
  stamp: { mutationVersion: 0, geometryContentVersion: 0 },
});

async function native(t: TestContext, resolved = false, partial = false, capped = false) {
  const pair = await revisionPair(t); if (!pair) return null;
  const baseReport = await runIds(pair, 'A');
  const wall = baseReport.specificationResults.find(spec => spec.specification.name === 'Walls are external')?.entityResults.find(row => row.passed && row.globalId);
  assert.ok(wall?.globalId);
  const view = new MutablePropertyView(pair.base.ifcDataStore.properties, 'A');
  view.setProperty(wall.expressId, 'Pset_WallCommon', 'IsExternal', false, PropertyValueType.Boolean);
  const base = run('base-native-ids', resolved ? await runIds(pair, 'A', { view }) : baseReport);
  const head = run('head-native-ids', await runIds(pair, 'B', { omitPassing: partial, ...(capped ? { maxEntities: 1 } : {}) }));
  useViewerStore.setState({ models: new Map([['A', pair.base], ['B', pair.head]]), compareResult: pair.compare,
    mutationVersion: 0, geometryContentVersion: 0, modelPlacement: initial.modelPlacement, compareRunCaptures: [head, base],
    compareReconciliation: null, savedComparisons: [], idsValidationReport: null, clashResult: null, clashRawResult: null });
  const saved = savedReconciliationOf(useViewerStore.getState(), base, head);
  assert.ok(saved?.outcome.ok, 'the unchanged committed IDS reconciles through the native implementation');
  assert.ok(saved.outcome.findings.length > 0);
  useViewerStore.getState().setCompareReconciliation(saved);
  return { pair, saved, wall };
}
const projected = () => captureReviewSnapshot().findings.filter(f => f.evidence.kind === 'run-reconciliation');

test('#7087 native IDS reconciliation enters Review with source states and exact model identities', async t => {
  const source = await native(t); if (!source || !source.saved.outcome.ok) return;
  const snapshot = captureReviewSnapshot(); assert.deepEqual(snapshot.failed, []);
  const findings = projected(); assert.equal(findings.length, source.saved.outcome.findings.length);
  assert.ok(findings.some(finding => finding.nativeStatus === 'persisting'));
  for (const finding of findings) {
    assert.equal(finding.elements.length, 1);
    const element = finding.elements[0];
    const model = useViewerStore.getState().models.get(element.modelId ?? ''); assert.ok(model?.ifcDataStore);
    assert.ok(model.ifcDataStore.entities.getExpressIdByGlobalId(element.globalId) > 0);
    assert.equal(finding.run.complete, true);
  }
  const card = snapshot.cards.find(card => card.findings.some(f => f.evidence.kind === 'run-reconciliation')); assert.ok(card);
  pinReviewCard(card, null); const evidence = captureEvidence('review');
  assert.equal((JSON.parse(evidence.payload) as { sourceAvailability: string }).sourceAvailability, 'available');
  useViewerStore.getState().setCompareReconciliation(null);
  assert.equal(useReviewAssistantCard.getState().card, null, 'replaced reconciliation invalidates the pinned native source');
  assert.equal(projected().length, 0);
});

test('#7087 native passing re-examination is a resolution candidate without a human decision', async t => {
  const source = await native(t, true); if (!source) return;
  const finding = projected().find(f => f.nativeStatus === 'resolved' && f.elements.some(e => e.globalId === source.wall.globalId));
  assert.ok(finding); assert.equal(finding.lifecycle, 'no-longer-observed'); assert.equal(finding.run.temporal, 'historical');
  const card = captureReviewSnapshot().cards.find(card => card.findings.some(f => f.id === finding.id)); assert.ok(card);
  pinReviewCard(card, null);
  const evidence = JSON.parse(captureEvidence('review').payload) as { sourceAvailability: string; evidence: { summary: { humanDecision: unknown } } };
  assert.equal(evidence.sourceAvailability, 'available');
  assert.equal(evidence.evidence.summary.humanDecision, null);

});

test('#7087 capped native IDS evidence never becomes a resolution candidate', async t => {
  const source = await native(t, true, true); if (!source) return;
  const findings = projected(); assert.ok(findings.length > 0);
  assert.ok(findings.every(finding => !finding.run.complete));
  assert.ok(findings.every(finding => finding.lifecycle !== 'no-longer-observed'));
  assert.ok(findings.some(finding => finding.nativeStatus === 'notEvaluated'));
});

test('#7087 later edits and missing captures preserve native states without implying current resolution', async t => {
  const source = await native(t, true); if (!source) return;
  const original = projected().find(f => f.nativeStatus === 'resolved'); assert.ok(original);
  useViewerStore.setState({ mutationVersion: 1 });
  assert.equal(openOriginal(original, () => assert.fail('stale original must not open')), false);
  const stale = projected(); assert.ok(stale.some(f => f.nativeStatus === 'resolved'));
  assert.ok(stale.every(f => f.lifecycle === 'not-evaluated' && !f.run.complete));
  useViewerStore.setState({ mutationVersion: 0, compareRunCaptures: [] });
  const unavailable = projected(); assert.equal(unavailable.length, stale.length);
  assert.ok(unavailable.every(f => f.elements.length === 0 && f.lifecycle === 'not-evaluated'));
});

test('#7087 Open original displays the native validation reconciliation row, including a persisting row', async t => {
  const source = await native(t); if (!source) return;
  const finding = projected().find(f => f.nativeStatus === 'persisting'); assert.ok(finding);
  const panels: string[] = [];
  assert.equal(openOriginal(finding, panel => panels.push(panel)), true); assert.deepEqual(panels, ['compare']);
  const ui = render(<CompareReconcileSection result={source.pair.compare} />);
  await waitFor(() => ui.querySelector('[aria-current="true"]') !== null, 'native reconciliation original');
  assert.ok(ui.querySelector('[aria-current="true"]')?.textContent?.includes(finding.title));
  assert.equal(document.activeElement, ui.querySelector('[aria-current="true"]'));
  act(() => useViewerStore.getState().setCompareReconciliation(null));
  assert.equal(openOriginal(finding, panel => panels.push(panel)), false, 'replaced original must refuse');
});


test('#7087 native clash reconciliation retains both occurrence references without cross-model guessing', async t => {
  const pair = await revisionPair(t); if (!pair) return;
  const captured = async (id: string, modelId: string): Promise<CapturedRun> => ({ id, kind: 'clash',
    result: await runClash(pair, [modelId]), modelIds: [modelId], capturedAt: '2026-10-08T00:00:00.000Z',
    stamp: { mutationVersion: 0, geometryContentVersion: 0 } });
  const base = await captured('base-native-clash', 'A'), head = await captured('head-native-clash', 'B');
  useViewerStore.setState({ models: new Map([['A', pair.base], ['B', pair.head]]), compareResult: pair.compare,
    mutationVersion: 0, geometryContentVersion: 0, compareRunCaptures: [head, base], savedComparisons: [],
    idsValidationReport: null, clashResult: null, clashRawResult: null });
  const saved = savedReconciliationOf(useViewerStore.getState(), base, head); assert.ok(saved?.outcome.ok);
  assert.ok(saved.outcome.counts.new > 0, 'the committed added duct creates a native clash');
  useViewerStore.getState().setCompareReconciliation(saved);
  const findings = projected(); assert.equal(findings.length, saved.outcome.findings.length);
  for (const finding of findings) {
    assert.equal(finding.elements.length, 2);
    assert.ok(finding.elements.every(element => element.modelId === 'B' &&
      pair.head.ifcDataStore.entities.getExpressIdByGlobalId(element.globalId) > 0));
  }
});

function NativeReviewCount() {
  const { snapshot } = useReviewSnapshot();
  return <output>{snapshot.findings.filter(f => f.evidence.kind === 'run-reconciliation').length}</output>;
}
test('#7087 the mounted native Review hook refreshes when only the reconciliation changes', async t => {
  const source = await native(t); if (!source || !source.saved.outcome.ok) return;
  const ui = render(<NativeReviewCount />);
  assert.equal(ui.querySelector('output')?.textContent, String(source.saved.outcome.findings.length));
  act(() => useViewerStore.getState().setCompareReconciliation(null)); await advance(0);
  assert.equal(ui.querySelector('output')?.textContent, '0');
});


test('#7087 an explicit native passing result cannot confirm resolution in a capped run', async t => {
  const source = await native(t, true, false, true); if (!source || !source.saved.outcome.ok) return;
  assert.equal(source.saved.outcome.partial, true);
  assert.ok(source.saved.outcome.counts.resolved > 0, 'the native cap retains the first wall passing result');
  const resolved = projected().filter(finding => finding.nativeStatus === 'resolved'); assert.ok(resolved.length > 0);
  assert.ok(resolved.every(finding => !finding.run.complete && finding.lifecycle === 'not-evaluated'));
});

test('#7087 incompatible native IDS sources stay outside Review reconciliation findings', async t => {
  const source = await native(t); if (!source) return;
  const changed = run('changed-native-ids', await runIds(source.pair, 'B', {
    edit: xml => xml.replace('Walls are external', 'Walls need a separate review'),
  }));
  const base = useViewerStore.getState().compareRunCaptures.find(run => run.id === 'base-native-ids'); assert.ok(base);
  const saved = savedReconciliationOf(useViewerStore.getState(), base, changed); assert.ok(saved && !saved.outcome.ok);
  assert.ok(saved.outcome.incompatibilities.some(reason => reason.code === 'sourceDiffers'));
  useViewerStore.setState({ compareRunCaptures: [changed, base], compareReconciliation: saved });
  assert.equal(projected().length, 0);
});
