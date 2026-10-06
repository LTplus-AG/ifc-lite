/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { Lens, LensRule } from '@ifc-lite/lens';
import { federationRegistry } from '@ifc-lite/renderer';
import { render, click, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { LensRuntimeHost } from '@/components/viewer/LensRuntimeHost';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { useAssistant, cancelAssistant } from '@/lib/assistant/conversation';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { adapterFor } from './registry';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); cancelAssistant(); federationRegistry.clear(); useViewerStore.setState(initial, true);
  useAssistant.setState({ snapshot: null, archived: null, messages: [], error: null, status: 'idle' });
});

const SAMPLES = ['building-architecture.ifc', 'building-architecture-rev-b.ifc'];

async function parse(file: string): Promise<IfcDataStore> {
  const bytes = readFileSync(new URL(`../../../../public/samples/${file}`, import.meta.url));
  return new IfcParser().parseColumnar(new Uint8Array(bytes).buffer, { disableWorkerScan: true });
}

/** Load the samples the way `useIfcLoader` does: registry offset, then `addModel`. */
async function load(count: 1 | 2): Promise<IfcDataStore[]> {
  const stores: IfcDataStore[] = [];
  for (const file of SAMPLES.slice(0, count)) {
    const store = await parse(file);
    let maxExpressId = 0;
    for (const id of store.entities.expressId) maxExpressId = Math.max(maxExpressId, id);
    const idOffset = useViewerStore.getState().registerModelOffset(file, maxExpressId);
    useViewerStore.getState().addModel({ id: file, name: file, ifcDataStore: store, geometryResult: null, visible: true, collapsed: false,
      schemaVersion: 'IFC4', loadedAt: 0, fileSize: 0, idOffset, maxExpressId, loadState: 'complete' });
    stores.push(store);
  }
  return stores;
}

const typeRule = (id: string, type: string): LensRule => ({ id, name: `${type} rule`, enabled: true, action: 'colorize', color: '#e53935',
  groups: [{ combinator: 'AND', rules: [{ kind: 'ifcType', values: [type], op: 'in' }] }] });

async function activate(lens: Lens): Promise<void> {
  await act(async () => { useViewerStore.setState({ savedLenses: [lens], activeLensId: lens.id }); });
  await act(async () => {
    const until = Date.now() + 10_000;
    while (!adapterFor('lens').readiness(useViewerStore.getState()).ready && Date.now() < until) await new Promise(r => setTimeout(r, 10));
  });
}

const typeCount = (stores: IfcDataStore[], type: string) => stores.reduce((sum, store) => sum + (store.entityIndex.byType.get(type)?.length ?? 0), 0);

// #6833: rule counts come from the live useLens evaluation of the real sample models;
// sample elements resolve to their own model's ids, at one and two federated models.
for (const count of [1, 2] as const) {
  test(`lens evidence carries native per-rule counts with resolved sample elements (${count} model(s), #6833)`, async () => {
    const stores = await load(count);
    render(<LensRuntimeHost />);
    assert.equal(JSON.parse(captureEvidence('lens').payload).sourceAvailability, 'unavailable', 'no active lens');
    await activate({ id: 'walls-slabs', name: 'Walls and slabs', rules: [typeRule('walls', 'IfcWall'), typeRule('slabs', 'IfcSlab'), { ...typeRule('off', 'IfcSpace'), enabled: false }] });

    const snapshot = captureEvidence('lens');
    const payload = JSON.parse(snapshot.payload);
    assert.equal(payload.sourceAvailability, 'available');
    assert.equal(snapshot.totalRows, 2, 'disabled rules are not evaluated');
    const [walls, slabs] = payload.evidence.rows.map((row: { data: Record<string, unknown> }) => row.data);
    assert.deepEqual([walls.kind, walls.unit, walls.count, slabs.count], ['lensRule', 'elements', typeCount(stores, 'IFCWALL'), typeCount(stores, 'IFCSLAB')]);
    const state = useViewerStore.getState();
    for (const ref of walls.sampleRefs as Array<{ modelId: string; expressId: number; globalId: string; type: string }>) {
      assert.equal(ref.type, 'IfcWall');
      assert.equal(state.models.get(ref.modelId)?.ifcDataStore?.entities.getGlobalId(ref.expressId), ref.globalId);
    }
    assert.ok((walls.count as number) > 0, 'the sample model has walls');
    assert.equal(new Set((walls.sampleRefs as Array<{ modelId: string }>).map(ref => ref.modelId)).size, count, 'samples carry each model\'s own ids');
    const summary = payload.evidence.summary;
    assert.deepEqual([summary.mode, summary.ruleCount, summary.enabledRuleCount, summary.totalMatched], ['rules', 3, 2, walls.count + slabs.count]);
    assert.ok(summary.unmatchedCount > 0, 'everything that is not a wall or slab is ghosted context');

    assert.equal(evidenceIsCurrent(snapshot), true);
    await act(async () => useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 }));
    assert.equal(evidenceIsCurrent(snapshot), false, 'an edit re-evaluates the lens and stales the evidence');
  });
}

// #6833: a lens with more rules than the row sample keeps exact totals; auto-colour reports its legend.
test('lens evidence keeps rule totals beyond the sample and reports auto-colour legend entries (#6833)', async () => {
  const stores = await load(1);
  render(<LensRuntimeHost />);
  const rules = [typeRule('walls', 'IfcWall'), ...Array.from({ length: 119 }, (_, i) => typeRule(`none-${i}`, 'IfcPile'))];
  await activate({ id: 'many', name: 'Many rules', rules });
  const many = captureEvidence('lens');
  const payload = JSON.parse(many.payload);
  assert.equal(many.totalRows, 120);
  assert.equal(payload.includedRows, 100);
  assert.equal(payload.sampled, true);
  assert.equal(payload.evidence.summary.totalMatched, typeCount(stores, 'IFCWALL'));

  await activate({ id: 'auto', name: 'By class', rules: [], autoColor: { source: 'ifcType' } });
  assert.equal(evidenceIsCurrent(many), false, 'another lens replaces the identity');
  const auto = JSON.parse(captureEvidence('lens').payload);
  assert.equal(auto.evidence.summary.mode, 'autoColor');
  const wallEntry = auto.evidence.rows.map((row: { data: Record<string, unknown> }) => row.data).find((row: Record<string, unknown>) => row.name === 'IfcWall');
  assert.equal(wallEntry?.kind, 'lensLegendEntry');
  assert.equal(wallEntry?.count, typeCount(stores, 'IFCWALL'));
});

// #6833: the Lens panel header discusses the active lens.
test('the Lens panel header attaches the active lens (#6833)', async () => {
  await load(1);
  render(<LensRuntimeHost />);
  await activate({ id: 'walls', name: 'Walls', rules: [typeRule('walls', 'IfcWall')] });
  const panel = render(renderPanelBody('lens', () => undefined));
  const discuss = panel.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(discuss);
  click(discuss);
  assert.equal(useAssistant.getState().snapshot?.source, 'lens');
  assert.equal(useAssistant.getState().snapshot?.totalRows, 1);
});
