/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import '@/test/content-fixture';
import { act } from 'react';
import { afterEach, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { useViewerStore } from '@/store';
import { revisionPair, runClash } from '@/lib/compare/revision-pair.test-support';
import { applyClashGroupPlan, newWorkspaceBase, planClashGroupApply, undoClashGroupApplication } from '@/lib/clash/group-apply';
import { manualClashOccurrenceKey } from '@/lib/clash/manual-groups';
import { useClashGroupApplications } from '@/lib/clash/group-applications';
import { useClashGroupLibrary } from '@/lib/clash/group-workspace';
import { readContentRows } from '@/lib/storage/content-database';
import { useReviewSnapshot } from '@/components/viewer/review/useReviewSnapshot';
import { ClashGroupApplications } from '@/components/viewer/assistant/ClashGroupApplicationCard';
import * as evidenceFocus from '@/lib/panels/evidence-focus';
import { captureReviewSnapshot, liveReviewModels } from '../collect';
import { buildCards } from '../cards';
import { pinReviewCard } from '../assistant';
import { useReviewAssistantCard } from '../assistant-state';
import { openOriginal } from '../open';
import { groupReceiptFindings } from './group-receipts';
import { render, cleanup, waitFor, advance } from '@/test/render';

const initial = useViewerStore.getState();
afterEach(() => { cleanup(); act(() => { useViewerStore.setState(initial, true); evidenceFocus.useClashApplicationFocus?.setState({ record: null }); }); });
const projected = () => captureReviewSnapshot().findings.filter(finding => finding.evidence.kind === 'clash-group-application');
async function applied(t: TestContext, partial = false, singleModel = false) {
  const pair = await revisionPair(t); if (!pair) return null;
  const result = await runClash(pair, singleModel ? ['B'] : ['A', 'B']);
  assert.ok(singleModel ? result.clashes.length === 1 : result.clashes.length > 1);
  useViewerStore.setState({ models: new Map([['A', pair.base], ['B', pair.head]]), clashResult: result, clashRawResult: result,
    idsValidationReport: null, compareResult: null, compareReconciliation: null, compareRunCaptures: [], savedComparisons: [] });
  const planned = planClashGroupApply([{ name: 'Native coordination', members: result.clashes.slice(0, 2).map(manualClashOccurrenceKey) }],
    newWorkspaceBase('Reviewed native groups'), result.clashes); assert.ok(planned.ok);
  const outcome = await applyClashGroupPlan(planned.plan, { confirmMoves: false, origin: '#7089 native oracle', source: partial ? 'sample' : 'full-run', partial });
  assert.ok(outcome.ok);
  assert.ok((await readContentRows('clashGroupApplications')).some(row => row.id === outcome.receipt.id && row.revision === 1));
  return { pair, result, receipt: outcome.receipt };
}

test('#7089 real native group apply enters Review with saved membership and verbatim receipt status', async t => {
  const source = await applied(t); if (!source) return;
  const findings = projected(); assert.equal(findings.length, 1); const [finding] = findings;
  assert.equal(finding.nativeStatus, 'applied'); assert.equal(finding.lifecycle, 'record');
  assert.equal(finding.run.temporal, 'historical'); assert.equal(finding.run.complete, false);
  assert.equal(finding.title, 'Native coordination'); assert.equal(finding.elements.length, 4);
  assert.ok(finding.elements.every(element => !!element.modelId && (element.modelId === 'A' ? source.pair.base : source.pair.head).ifcDataStore.entities.getExpressIdByGlobalId(element.globalId) > 0));
  assert.ok(finding.detail.includes('native continuity: unchanged 2; reidentified 0; gone 0'));
  const receiptOnly = buildCards(findings, liveReviewModels()); assert.equal(receiptOnly.cards[0].state, 'record');
  assert.equal(receiptOnly.totals.currentFindings, 0); assert.equal(receiptOnly.totals.historicalFindings, 0);
  assert.equal(receiptOnly.totals.cards, 1);
  const snapshot = captureReviewSnapshot(); assert.deepEqual(snapshot.failed, []);
  assert.equal(snapshot.totals.currentFindings, source.result.clashes.length, 'saving a grouping decision does not add analysis findings');
  assert.equal(snapshot.totals.historicalFindings, 0);
});

test('#7089 partial sample receipts never confirm native resolution', async t => {
  const source = await applied(t, true); if (!source) return;
  const [finding] = projected(); assert.ok(finding);
  assert.ok(finding.run.incomplete.some(gap => gap.detail === 'sample; partial=true'));
  assert.equal(finding.lifecycle, 'record'); assert.equal(buildCards([finding], liveReviewModels()).cards[0].state, 'record');
});

test('#7089 absent native members remain an unvalidated record with explicit continuity', async t => {
  const source = await applied(t); if (!source) return;
  const result = { ...source.result, clashes: source.result.clashes.slice(1) };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  const [finding] = projected(); assert.ok(finding);
  assert.deepEqual(finding.elements, []); assert.ok(finding.detail.includes('native continuity: unchanged 1; reidentified 0; gone 1'));
  const card = buildCards([finding], liveReviewModels()).cards[0]; assert.equal(card.identity, 'unvalidated'); assert.equal(card.state, 'record');
});

test('#7089 duplicate native occurrences do not acquire group element identity', async t => {
  const source = await applied(t); if (!source) return;
  const result = { ...source.result, clashes: [...source.result.clashes, source.result.clashes[0]] };
  useViewerStore.setState({ clashResult: result, clashRawResult: result });
  const [finding] = projected(); assert.ok(finding); assert.deepEqual(finding.elements, []);
  assert.ok(finding.detail.includes('Native membership ambiguous'));
});

test('#7089 stale current runs keep receipt provenance without current element claims', async t => {
  const source = await applied(t); if (!source) return;
  const result = groupReceiptFindings([source.receipt], useClashGroupLibrary.getState().entries, { result: source.result, stale: true }, liveReviewModels());
  assert.equal(result.findings[0].nativeStatus, 'applied'); assert.deepEqual(result.findings[0].elements, []);
  assert.ok(result.runs[0].incomplete.some(gap => gap.code === 'stale'));
});

function ReceiptCount() {
  const { snapshot } = useReviewSnapshot();
  return <output>{snapshot.findings.filter(finding => finding.evidence.kind === 'clash-group-application').map(finding => finding.nativeStatus).join(',')}</output>;
}
test('#7089 native receipt undo refreshes mounted Review and invalidates pinned source evidence', async t => {
  const source = await applied(t); if (!source) return;
  const ui = render(<ReceiptCount />); assert.equal(ui.querySelector('output')?.textContent, 'applied');
  const card = captureReviewSnapshot().cards.find(card => card.findings.some(finding => finding.evidence.kind === 'clash-group-application')); assert.ok(card);
  pinReviewCard(card, null);
  await act(async () => { assert.equal((await undoClashGroupApplication(source.receipt)).ok, true); }); await advance(0);
  assert.equal(ui.querySelector('output')?.textContent, 'undone'); assert.equal(useReviewAssistantCard.getState().card, null);
  assert.ok(projected()[0].detail.some(line => line.startsWith('undone ')));
});

test('#7089 removed workspace groups refresh mounted Review and invalidate pinned continuity', async t => {
  const source = await applied(t); if (!source) return;
  const card = captureReviewSnapshot().cards.find(card => card.findings.some(finding => finding.evidence.kind === 'clash-group-application')); assert.ok(card);
  function Continuity() { const { snapshot } = useReviewSnapshot(); return <output>{snapshot.findings.find(finding => finding.evidence.kind === 'clash-group-application')?.detail.join(';')}</output>; }
  const ui = render(<Continuity />); pinReviewCard(card, null);
  act(() => useClashGroupLibrary.setState(state => ({ entries: state.entries.map(workspace => ({ ...workspace, groups: [] })) })));
  await advance(0); assert.ok(ui.querySelector('output')?.textContent?.includes('missing groups 1'));
  assert.equal(useReviewAssistantCard.getState().card, null);
});

test('#7089 original navigation exposes the exact undone receipt and restores repeated focus', async t => {
  const source = await applied(t); if (!source) return;
  const undone = await undoClashGroupApplication(source.receipt); assert.ok(undone.ok);
  const [finding] = projected(); assert.ok(finding); const panels: string[] = [];
  assert.equal(openOriginal(finding, panel => panels.push(panel)), true); assert.deepEqual(panels, ['clash']);
  const ui = render(<ClashGroupApplications />);
  await waitFor(() => ui.querySelector('[aria-current="true"]') !== null, 'undone receipt original');
  assert.ok(ui.querySelector('[aria-current="true"]')?.textContent?.includes(source.receipt.workspaceName));
  assert.equal(document.activeElement, ui.querySelector('[aria-current="true"]'));
  const away = document.createElement('button'); ui.append(away); away.focus();
  act(() => { assert.equal(openOriginal(finding, panel => panels.push(panel)), true); });
  await waitFor(() => document.activeElement === ui.querySelector('[aria-current="true"]'), 'repeated receipt focus');
  act(() => useClashGroupApplications.setState({ entries: [] }));
  assert.equal(openOriginal(finding, panel => panels.push(panel)), false, 'deleted receipt original refuses');
});


test('#7089 unavailable detection keeps saved grouping provenance without invented elements', async t => {
  const source = await applied(t); if (!source) return;
  useViewerStore.setState({ clashResult: null, clashRawResult: null });
  const [finding] = projected(); assert.ok(finding); assert.equal(finding.title, 'Native coordination');
  assert.deepEqual(finding.elements, []); assert.ok(finding.detail.includes('saved members 2'));
  assert.ok(finding.detail.includes('Native continuity unavailable'));
});

test('#7089 unknown saved population is disclosed and never treated as zero new findings', async t => {
  const source = await applied(t); if (!source) return;
  const receipt = { ...source.receipt, population: null };
  const result = groupReceiptFindings([receipt], useClashGroupLibrary.getState().entries, { result: source.result, stale: false }, liveReviewModels());
  assert.ok(result.findings[0].detail.includes('missing groups 0; new findings unknown'));
  assert.equal(result.findings[0].lifecycle, 'record'); assert.equal(result.runs[0].complete, false);
});


test('#7089 native durable membership reidentifies a uniquely matched finding after model reload', async t => {
  const source = await applied(t, false, true); if (!source) return;
  // Preserve actual native mesh/GUID evidence; only the ephemeral loaded-model id changes.
  const result = { ...source.result, clashes: source.result.clashes.map(clash => ({ ...clash,
    a: { ...clash.a, model: 'B-reloaded' }, b: { ...clash.b, model: 'B-reloaded' },
  })) };
  useViewerStore.setState({ models: new Map([['B-reloaded', { ...source.pair.head, id: 'B-reloaded' }]]), clashResult: result, clashRawResult: result });
  const [finding] = projected(); assert.ok(finding);
  assert.ok(finding.detail.includes('native continuity: unchanged 0; reidentified 1; gone 0'));
  assert.equal(finding.elements.length, 2);
  assert.ok(finding.elements.every(element => element.modelId === 'B-reloaded' && source.pair.head.ifcDataStore.entities.getExpressIdByGlobalId(element.globalId) > 0));
  assert.equal(finding.nativeStatus, 'applied'); assert.equal(finding.lifecycle, 'record');
});
