/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { IfcParser } from '@ifc-lite/parser';
import { parseIDS, validateIDS } from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';
import { createBimContext } from '@ifc-lite/sdk';
import { MemoCache, parseFlowDocument } from '@ifc-lite/flow';
import { useViewerStore } from '@/store';
import { LocalBackend } from '@/sdk/local-backend';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { validationReportSnapshot, newSavedReport } from '@/lib/validation/reports/history';
import { runFlowInViewer } from './runner';

const initial = useViewerStore.getState();
afterEach(() => useViewerStore.setState(initial, true));
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
const samples = new URL('../../../public/samples/', import.meta.url);

for (const count of [1, 2]) {
  test(`#7372 actual viewer Flow reads both saved native wire formats with ${count} models without editors or scene changes`, async () => {
    const bytes = new Uint8Array(readFileSync(new URL('building-architecture.ifc', samples)));
    const hash = createHash('sha256').update(bytes).digest('hex');
    const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    const originalId = 'original-native-producer';
    const report = await validateIDS(parseIDS(readFileSync(new URL('building-architecture.ids', samples), 'utf8')),
      createDataAccessor(store), { modelId: originalId, schemaVersion: store.schemaVersion, entityCount: store.entityCount });
    for (const spec of report.specificationResults) {
      assert.ok(!spec.error);
      assert.notEqual(spec.setResultsTruncated, true);
      assert.equal(spec.entityResults.length, spec.applicableCount);
    }
    const failed = report.specificationResults.flatMap(spec => spec.entityResults.filter(entity => !entity.passed));
    assert.ok(failed.length > 0);
    const scope = new Map([[originalId, { name: 'building-architecture.ifc', ifcDataStore: store }]]);
    // Canonical real saved-report producer supplies exact native failure rows.
    // This older format has no captured full SHA, so import must leave it
    // explicitly unbound, even when its model name matches today's model.
    const savedReport = newSavedReport(validationReportSnapshot(report, scope, 'actual-saved-report'));
    assert.equal(savedReport.snapshot.kind, 'ids-report');
    if (savedReport.snapshot.kind !== 'ids-report') throw new Error('Actual saved native report required');
    assert.equal(savedReport.snapshot.elementEvidence?.rows.length, failed.length);
    const stamp = report.timestamp.toISOString();
    const savedAnalysis = { version: 1, id: 'actual-viewer-native-report', capturedAt: stamp, savedAt: stamp,
      models: [{ key: originalId, name: 'building-architecture.ifc', sourceContentHash: hash }], examined: [originalId],
      freshness: 'current', edited: false, placementRecorded: false, frame: null, kind: 'validation', report, ruleSet: null };

    // Reload into real columnar stores and new ids; the host gets no original
    // native report state. Scene scaffolding never supplies identity data.
    const loadedStore = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
    const model = { ...fixtureModel('reloaded-architecture'), name: 'building-architecture.ifc', ifcDataStore: loadedStore };
    const models = [model];
    if (count === 2) {
      const peerBytes = new Uint8Array(readFileSync(new URL('building-architecture-rev-b.ifc', samples)));
      const peer = await new IfcParser().parseColumnar(peerBytes.slice().buffer, { disableWorkerScan: true });
      models.push({ ...fixtureModel('unevaluated-peer', { idOffset: 1_000_000 }), name: 'revision-b.ifc', ifcDataStore: peer });
    }
    useViewerStore.setState({ ...fixtureModels(...models), mutationViews: new Map(), storeEditors: new Map(),
      dirtyModels: new Set(), undoStacks: new Map(), redoStacks: new Map() });
    const before = useViewerStore.getState();
    const beforeModels = before.models;
    const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
    for (const format of ['analysis', 'validation'] as const) {
      const params = format === 'analysis' ? { savedAnalysisRuns: [savedAnalysis] } : { savedValidationReports: [savedReport] };
      const graph = parseFlowDocument(JSON.stringify({ flowVersion: 1, id: `7372-viewer-import-${format}`, name: 'Read saved native evidence',
        capabilities: ['model.read'], inputs: [], edges: [], outputs: [{ nodeId: 'read', port: 'snapshot', label: 'Historical facts' }],
        nodes: [{ id: 'read', type: 'review.snapshot', params: { ...params, sources: ['validation'], maxFindings: 128 } }] }));
      const result = await runFlowInViewer({ doc: graph, bim, pin: hash, cache: new MemoCache() });
      assert.equal(result.ok, true, JSON.stringify(result.log));
      const output = result.outputs.get('read')?.get('snapshot');
      assert.ok(output?.kind === 'item' && record(output.value));
      if (output?.kind !== 'item' || !record(output.value)) throw new Error('Actual viewer Flow historical projection missing');
      const snapshot = output.value;
      assert.equal(snapshot.origin, 'imported');
      assert.deepEqual(snapshot.provenance, []);
      assert.ok(record(snapshot.bounds));
      assert.equal(snapshot.bounds.nativeCoverageComplete, false);
      assert.ok(Array.isArray(snapshot.findings));
      assert.equal(snapshot.findings.length, failed.length);
      const guids = snapshot.findings.flatMap(finding => record(finding) && Array.isArray(finding.elements)
        ? finding.elements.flatMap(element => record(element) && typeof element.globalId === 'string' ? [element.globalId] : []) : []);
      assert.deepEqual(guids.sort(), failed.map(entity => entity.globalId).sort());
      assert.ok(Array.isArray(snapshot.bindings) && record(snapshot.bindings[0]));
      assert.equal(snapshot.bindings[0].state, format === 'analysis' ? 'bound' : 'unbound');
      if (format === 'validation') {
        for (const finding of snapshot.findings) {
          assert.ok(record(finding) && Array.isArray(finding.elements));
          for (const element of finding.elements) { assert.ok(record(element)); assert.equal(element.modelId, null); }
        }
      }
      assert.equal(useViewerStore.getState().models, beforeModels);
      assert.equal(useViewerStore.getState().storeEditors.size, 0);
      assert.equal(useViewerStore.getState().mutationViews.size, 0);
      assert.equal(useViewerStore.getState().dirtyModels.size, 0);
      assert.equal(useViewerStore.getState().geometryContentVersion, before.geometryContentVersion);
      assert.equal(createHash('sha256').update(loadedStore.source.materialize()).digest('hex'), hash);
    }
  });
}


// #7372 / 4254309182: this is the real viewer runner and LocalBackend, not
// only a direct call to the provider's unsupported-mode guard.
test('#7372 viewer rejects native Review before actual registered attribute writes', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('building-architecture.ifc', samples)));
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const model = { ...fixtureModel('preflight-architecture'), name: 'building-architecture.ifc', ifcDataStore: store };
  useViewerStore.setState({ ...fixtureModels(model), mutationViews: new Map(), storeEditors: new Map(),
    dirtyModels: new Set(), undoStacks: new Map(), redoStacks: new Map() });
  useViewerStore.getState().setEditEnabled(true);
  assert.equal(useViewerStore.getState().editEnabled, true, 'actual normal Edit mode must be available');
  assert.equal(useViewerStore.getState().canCollabEdit(), true);
  const bim = createBimContext({ backend: new LocalBackend(useViewerStore) });
  assert.equal(bim.model.activeId(), model.id);
  const walls = bim.query().model(model.id).byType('IfcWall').toArray();
  assert.ok(walls.length > 0, 'actual authored wall population required');
  const originalNames = walls.map(wall => bim.entity(wall.ref)?.name);
  const graph = parseFlowDocument(JSON.stringify({ flowVersion: 1, id: 'viewer-review-preflight', name: 'Unsupported native Review',
    capabilities: ['model.read', 'model.mutate:attr.Name'], inputs: [], outputs: [],
    nodes: [{ id: 'model', type: 'core.string', params: { value: model.id } },
      { id: 'walls', type: 'model.byType', params: { type: 'IfcWall' } },
      { id: 'name', type: 'core.string', params: { value: 'Must not write before unsupported Review' } },
      { id: 'write', type: 'model.setAttribute', params: { attribute: 'Name' } },
      { id: 'read', type: 'review.snapshot', params: {} }],
    edges: [{ from: ['model', 'value'], to: ['walls', 'modelId'] },
      { from: ['walls', 'entities'], to: ['write', 'entity'] },
      { from: ['name', 'value'], to: ['write', 'value'] }, { from: ['write', 'entity'], to: ['read', 'after'] }],
  }));
  let failure: unknown;
  try { await runFlowInViewer({ doc: graph, bim, pin: 'actual-preflight-source', cache: new MemoCache() }); }
  catch (error) { failure = error; }
  assert.deepEqual(walls.map(wall => bim.entity(wall.ref)?.name), originalNames, 'real authored Names must be unchanged');
  assert.equal(useViewerStore.getState().storeEditors.size, 0);
  assert.equal(useViewerStore.getState().mutationViews.size, 0);
  assert.equal(useViewerStore.getState().dirtyModels.size, 0);
  assert.ok(failure instanceof Error && failure.message.includes('review.native'));
  const supplied = { ...graph, inputs: [{ nodeId: 'read', param: 'savedValidationReports', kind: 'scalar' as const, label: 'Saved history' }] };
  const allowed = await runFlowInViewer({ doc: supplied, bim, pin: 'actual-preflight-source', cache: new MemoCache(),
    inputs: { 'read.savedValidationReports': [] } });
  assert.equal(allowed.ok, true, JSON.stringify(allowed.log));
  const queried = allowed.outputs.get('walls')?.get('entities');
  assert.equal(queried?.kind, 'list', 'actual registered graph must return its authored wall population');
  if (queried?.kind !== 'list') throw new Error('Actual authored wall list required');
  assert.deepEqual(queried.items.map(value => record(value) ? value.globalId : undefined), walls.map(wall => wall.globalId));
  assert.equal(allowed.reports.find(report => report.nodeId === 'write')?.status, 'ok');
  assert.equal(allowed.writes, 1, 'actual registered write node must execute');
  assert.ok(useViewerStore.getState().mutationViews.get(model.id), 'actual Name edit must retain its mutation view');
  assert.deepEqual(walls.map(wall => bim.entity(wall.ref)?.name), walls.map(() => 'Must not write before unsupported Review'));
});
