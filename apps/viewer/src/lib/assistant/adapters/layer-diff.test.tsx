/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProvenanceManifest, IFCLITE_ATTR, setProvenance, type IfcxFile, type IfcxNode } from '@ifc-lite/ifcx';
import { render, click, cleanup, waitFor } from '@/test/render';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { renderPanelBody } from '@/lib/panels/renderPanelBody';
import { computeLayerContribution, layerStackEntry } from '@/lib/layers/stack';
import { useViewerStore } from '@/store';
import { captureEvidence, evidenceIsCurrent } from '../evidence';
import { useAssistant, cancelAssistant } from '../conversation';

const initial = useViewerStore.getState();
const initialAssistant = useAssistant.getState();
afterEach(() => { cleanup(); cancelAssistant(); useAssistant.setState(initialAssistant, true); useViewerStore.setState(initial, true); });

const WINDOW = '25503984-6605-43a1-8597-eae657ff5bea';
const SITE = '14adb22b-d474-48a2-8e8f-6d4c067c1953';
const FIRE = 'bsi::ifc::v5a::Pset_FireSafety::FireRating';

/** buildingSMART's Hello Wall as the base, and an agent-authored layer on top that adds 120 nodes, edits one and tombstones one. */
async function stack() {
  const base = JSON.parse(await readFile(new URL('../../../../public/samples/hello-wall.ifcx', import.meta.url), 'utf8')) as IfcxFile;
  const data: IfcxNode[] = [
    ...Array.from({ length: 120 }, (_, i) => ({ path: `added-${String(i).padStart(3, '0')}`, attributes: { [FIRE]: 'REI60' } })),
    { path: WINDOW, attributes: { [FIRE]: 'EI30' } },
    { path: SITE, attributes: { [IFCLITE_ATTR.DELETED]: true } },
  ];
  const delta = setProvenance({ header: { ...base.header, id: 'delta' }, imports: [], schemas: {}, data }, createProvenanceManifest({
    author: { kind: 'agent', principal: 'agent:fire-review', model: 'test-model' }, intent: 'Add fire ratings',
    base: { kind: 'layer', id: 'blake3:base' }, created: '2026-01-02T03:04:05.000Z',
    checks: [{ tool: '@ifc-lite/ids', spec: 'fire.ids', result: 'pass' }, { tool: '@ifc-lite/ids', spec: 'names.ids', result: 'fail' }],
    signatures: [{ alg: 'ed25519', key: 'PUBLIC-KEY-MATERIAL', sig: 'SIGNATURE-MATERIAL' }],
  }));
  const bytes = (file: IfcxFile) => new TextEncoder().encode(JSON.stringify(file)).buffer as ArrayBuffer;
  const entries = [layerStackEntry({ id: 'base', name: 'hello-wall.ifcx', file: base, buffer: bytes(base) }),
    layerStackEntry({ id: 'delta', name: 'fire.ifcx', file: delta, buffer: bytes(delta) })];
  // Composition bridge: the edited window resolves to entity 7 of the composed model.
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('composed'), maxExpressId: 1000 } as never) });
  useViewerStore.getState().setLayerStack(entries, new Map([[WINDOW, 7]]));
  const diff = await computeLayerContribution(entries, 'delta');
  assert.ok(diff);
  useViewerStore.getState().setLayerStackDiff({ layerId: 'delta', diff });
  return diff;
}

const rowsOf = (payload: { evidence: { rows: Array<{ data: Record<string, unknown> }> } }) => payload.evidence.rows.map(row => row.data);

// #6833: the native StackDiff, exact counts beyond the sample, and provenance without signatures.
test('layer diff evidence lists native diff entries with exact counts and layer provenance', async () => {
  const diff = await stack();
  const snapshot = captureEvidence('layerDiff');
  const payload = JSON.parse(snapshot.payload);
  assert.equal(payload.sourceAvailability, 'available');
  assert.deepEqual(payload.evidence.summary.counts, { added: diff.added.length, modified: diff.modified.length, deleted: diff.deleted.length });
  assert.equal(diff.added.length, 120);
  assert.ok(diff.deleted.includes(SITE), 'the tombstone is a native deletion');
  assert.equal(snapshot.totalRows, diff.added.length + diff.modified.length + diff.deleted.length);
  assert.ok(snapshot.includedRows <= 100);
  assert.equal(payload.sampled, true);
  const layer = payload.evidence.summary.layer;
  assert.equal(layer.name, 'fire.ifcx');
  assert.equal(layer.position, 2);
  assert.equal(layer.authorKind, 'agent');
  assert.equal(layer.authorPrincipal, 'agent:fire-review');
  assert.deepEqual(layer.checks, { passed: 1, total: 2 });
  assert.equal(payload.evidence.summary.layerCount, 2);
  assert.ok(!snapshot.payload.includes('SIGNATURE-MATERIAL') && !snapshot.payload.includes('PUBLIC-KEY-MATERIAL'), 'signatures never leave the layer');
  const first = rowsOf(payload)[0];
  assert.equal(first.change, 'added');
  assert.equal(first.path, 'added-000');
  assert.equal(first.resolvedInComposition, false);
  assert.equal(evidenceIsCurrent(snapshot), true);
});

test('modified paths resolve through the composition bridge; reopening another layer makes evidence stale', async () => {
  const diff = await stack();
  // Only the native diff's modified entries, so they fall inside the 100-row sample (120 adds sort first).
  useViewerStore.getState().setLayerStackDiff({ layerId: 'delta', diff: { added: [], deleted: [], modified: diff.modified } });
  const snapshot = captureEvidence('layerDiff');
  const window = rowsOf(JSON.parse(snapshot.payload)).find(row => row.path === WINDOW);
  assert.ok(window);
  assert.equal(window.change, 'modified');
  assert.equal(window.modelId, 'composed');
  assert.equal(window.expressId, 7);
  assert.ok(Array.isArray(window.components) && window.components.length > 0);
  useViewerStore.getState().setLayerStackDiff({ layerId: 'base', diff });
  assert.equal(evidenceIsCurrent(snapshot), false);
  const again = captureEvidence('layerDiff');
  useViewerStore.setState({ mutationVersion: useViewerStore.getState().mutationVersion + 1 });
  assert.equal(evidenceIsCurrent(again), false);
});

test('layer diff is unavailable until a diff is computed, and available-empty for a no-op layer', async () => {
  await stack();
  useViewerStore.getState().setLayerStackDiff(null);
  assert.equal(JSON.parse(captureEvidence('layerDiff').payload).sourceAvailability, 'unavailable');
  useViewerStore.getState().setLayerStackDiff({ layerId: 'delta', diff: { added: [], deleted: [], modified: [] } });
  const snapshot = captureEvidence('layerDiff');
  assert.equal(JSON.parse(snapshot.payload).sourceAvailability, 'available');
  assert.equal(snapshot.totalRows, 0);
});

test('the Layers panel header discusses the layer diff', async () => {
  await stack();
  const ui = render(renderPanelBody('layers', () => undefined));
  await waitFor(() => ui.querySelector('button[aria-label="Discuss with AI"]') !== null, 'lazy Layers panel renders its header action');
  const button = ui.querySelector('button[aria-label="Discuss with AI"]');
  assert.ok(button);
  click(button);
  assert.equal(useAssistant.getState().snapshot?.source, 'layerDiff');
});
