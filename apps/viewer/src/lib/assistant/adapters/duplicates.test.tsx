/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { findDuplicates, groupDuplicateSets, type ClashElement } from '@ifc-lite/clash';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, cleanup } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { seedCoincidentWalls } from '@/test/clash-run-fixture';
import { useViewerStore, type FederatedModel } from '@/store';
import { captureAnalysisStamp, stampAnalysisReport } from '@/hooks/useAnalysisStaleness';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { adapterFor } from './registry';

Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { get: () => 800, configurable: true });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { get: () => 600, configurable: true });

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); federationRegistry.clear(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

function button(container: HTMLElement, text: string): HTMLElement {
  const found = [...container.querySelectorAll('button')].find(b => b.textContent?.trim() === text || b.getAttribute('aria-label') === text);
  assert.ok(found, `button "${text}" rendered`);
  return found;
}

async function clickAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  await act(async () => {
    const until = Date.now() + 10_000;
    while (useViewerStore.getState().clashRunning && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
  });
}

/** The coincident-walls fixture, re-homed on offsets the federation registry actually issued, as a real load does. */
async function seedRegisteredWalls(modelCount: 1 | 2): Promise<void> {
  await seedCoincidentWalls(modelCount, 4);
  federationRegistry.clear();
  const models = new Map<string, FederatedModel>();
  for (const [id, model] of useViewerStore.getState().models) {
    const offset = federationRegistry.registerModel(id, model.maxExpressId);
    const geometry = model.geometryResult;
    assert.ok(geometry);
    const meshes = geometry.meshes.map(mesh => ({ ...mesh, expressId: mesh.expressId - model.idOffset + offset }));
    models.set(id, { ...model, idOffset: offset, geometryResult: { ...geometry, meshes } });
  }
  useViewerStore.setState({ models });
}

// #6833: the Clash panel's Discuss attaches coincident SETS after "Find duplicates"
// (the real useClash scan over parsed walls and meshes), and plain clashes otherwise.
for (const modelCount of [1, 2] as const) {
  test(`duplicate scan in the Clash panel discusses one row per coincident set (${modelCount} model(s), #6833)`, async () => {
    await seedRegisteredWalls(modelCount);
    const panel = render(renderPanelBody('clash', () => undefined));
    await clickAndSettle(button(panel, 'Detect all clashes'));
    await act(async () => button(panel, 'Discuss with AI').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal(useAssistant.getState().snapshot?.source, 'clash', 'a clash run is discussed as clashes');
    assert.equal(JSON.parse(captureEvidence('duplicates').payload).sourceAvailability, 'unavailable', 'no duplicate scan yet');

    act(() => useViewerStore.getState().setClashResult(null));
    await clickAndSettle(button(panel, 'Find duplicates'));
    assert.equal(useViewerStore.getState().clashResult?.clashes.length, 6, 'four coincident walls are six native pairs');
    await act(async () => button(panel, 'Discuss with AI').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const snapshot = useAssistant.getState().snapshot;
    assert.equal(snapshot?.source, 'duplicates');
    assert.ok(snapshot);
    const payload = JSON.parse(snapshot.payload);
    assert.equal(payload.sourceAvailability, 'available');
    assert.equal(snapshot.totalRows, 1, 'one set, not six pair rows');
    const summary = payload.evidence.summary;
    assert.deepEqual([summary.setCount, summary.elementCount, summary.pairCount], [1, 4, 6]);
    assert.equal(summary.units.positionTolerance, 'm');
    const row = payload.evidence.rows[0].data;
    assert.equal(row.kind, 'duplicateSet');
    assert.deepEqual([row.memberCount, row.pairCount], [4, 6]);
    assert.match(row.title, /^4 coincident /);
    // Members resolve to each model's own local express ids and parsed GlobalIds.
    const state = useViewerStore.getState();
    for (const member of row.members) {
      const store = state.models.get(member.modelId)?.ifcDataStore;
      assert.ok(store, `member model ${member.modelId} is loaded`);
      assert.ok(member.expressId >= 1 && member.expressId <= 4 / modelCount, `local express id ${JSON.stringify(member)}`);
      assert.equal(store.entities.getGlobalId(member.expressId), member.globalId);
      assert.equal(member.type, 'IfcWall');
    }
    assert.deepEqual([...new Set(row.members.map((m: { modelId: string }) => m.modelId))].sort(), modelCount === 1 ? ['A'] : ['A', 'B']);

    // A stamped scan that predates an edit is never current again.
    assert.equal(evidenceIsCurrent(snapshot), true);
    act(() => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
    assert.equal(evidenceIsCurrent(snapshot), false);
    assert.equal(evidenceIsCurrent(captureEvidence('duplicates')), false, 'the scan predates the edit');
  });
}

async function parse(file: string): Promise<IfcDataStore> {
  const bytes = readFileSync(new URL(`../../../../public/samples/${file}`, import.meta.url));
  return new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
}

function box(dx: number): Pick<ClashElement, 'bounds' | 'positions' | 'indices'> {
  return {
    bounds: { min: [dx, 0, 0], max: [dx + 1, 1, 1] },
    positions: new Float32Array([dx, 0, 0, dx + 1, 0, 0, dx + 1, 1, 0, dx, 1, 0, dx, 0, 1, dx + 1, 0, 1, dx + 1, 1, 1, dx, 1, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0]),
  };
}

// #6833: more than 100 duplicate sets over three real federated sample models: native totals
// survive the 100-row sample, members keep their own model's ids, and an empty scan is available with zero rows.
test('duplicate evidence keeps native set totals beyond the row sample and reports an empty scan as available', async () => {
  const files = ['building-architecture.ifc', 'building-architecture-rev-b.ifc', 'infra-bridge.ifc'];
  const elements: ClashElement[] = [];
  const models: FederatedModel[] = [];
  for (const file of files) {
    const store = await parse(file);
    let maxExpressId = 0;
    for (const id of store.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    const offset = federationRegistry.registerModel(file, maxExpressId);
    models.push({ ...fixtureModel(file), idOffset: offset, maxExpressId, ifcDataStore: store });
    for (const id of store.entities.expressId) {
      const key = store.entities.getGlobalId(id);
      if (key) elements.push({ key, ref: offset + id, model: file, tag: store.entities.getTypeName(id), ...box(0) });
    }
  }
  useViewerStore.setState({ models: new Map(models.map(model => [model.id, model])), activeModelId: files[0] });
  const pairs = Math.floor(elements.length / 2);
  assert.ok(pairs > 100, `the samples supply more than 100 duplicate pairs (${pairs})`);
  const placed = elements.slice(0, pairs * 2).map((el, i) => ({ ...el, ...box(Math.floor(i / 2) * 10) }));

  const publish = (els: ClashElement[]) => {
    const result = findDuplicates(els);
    useViewerStore.getState().setClashResult(stampAnalysisReport(result, captureAnalysisStamp(true)));
    useViewerStore.getState().setClashGroups(groupDuplicateSets(result));
  };
  publish(placed);
  const snapshot = captureEvidence('duplicates');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(snapshot.totalRows, pairs);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  const summary = payload.evidence.summary;
  assert.deepEqual([summary.setCount, summary.elementCount, summary.pairCount], [pairs, pairs * 2, pairs]);
  const state = useViewerStore.getState();
  const membersByModel = new Set<string>();
  for (const { data } of payload.evidence.rows) {
    for (const member of data.members) {
      membersByModel.add(member.modelId);
      const store = state.models.get(member.modelId)?.ifcDataStore;
      assert.equal(store?.entities.getGlobalId(member.expressId), member.globalId);
    }
  }
  assert.ok(membersByModel.size >= 2, 'sampled rows span the federation');

  publish(placed.map((el, i) => ({ ...el, ...box(i * 10) })));
  assert.equal(evidenceIsCurrent(snapshot), false, 'a new scan replaces the identity');
  const empty = captureEvidence('duplicates');
  assert.equal(JSON.parse(empty.payload).sourceAvailability, 'available');
  assert.equal(empty.totalRows, 0);
  assert.equal(evidenceIsCurrent(empty), true);
});

test('the picker counts the sets capture will attach, even without a stored grouping', () => {
  const elements: ClashElement[] = Array.from({ length: 6 }, (_, i) => ({ key: `G${i}`, ref: i + 1, model: 'a.ifc', tag: 'IfcWall', ...box(Math.floor(i / 2) * 10) }));
  useViewerStore.setState(fixtureModels(fixtureModel('a.ifc')));
  useViewerStore.getState().setClashResult(stampAnalysisReport(findDuplicates(elements), captureAnalysisStamp(true)));
  useViewerStore.getState().setClashGroups([]);
  const state = useViewerStore.getState();
  assert.equal(captureEvidence('duplicates').totalRows, 3, 'capture falls back to the canonical set partition');
  assert.deepEqual(adapterFor('duplicates').readiness(state).status, { labelKey: 'assistantSources.duplicates.pickSets', params: { count: 3 } });
});
