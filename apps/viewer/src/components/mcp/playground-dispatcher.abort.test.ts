/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryProcessor, type GeometryResult } from '@ifc-lite/geometry';
import { BsddNamespace } from '@ifc-lite/sdk';
import type { ClashElement, ClashRule, ClashSettings } from '@ifc-lite/clash';
import { dispatch, parsePlaygroundModel } from './playground-dispatcher';
import { playgroundFiles } from './playground-files';

async function model(name: string) {
  const step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCWALL('0aBcDeFgHiJkLmNoPqRsT3',$,'Wall A',$,$,$,$,$,.STANDARD.);\nENDSEC;\nEND-ISO-10303-21;\n`;
  return parsePlaygroundModel(new TextEncoder().encode(step).buffer, name);
}

it('#9577 N1 an already-aborted dispatch cannot mutate a model', async () => {
  const m = await model('pre-abort.ifc');
  const controller = new AbortController(); controller.abort();
  const result = await dispatch(m, 'entity_set_attribute', { express_id: 1, attribute: 'Name', value: 'Forbidden' }, { signal: controller.signal });
  assert.equal(m.backend.getMutationView()?.hasPendingChanges() ?? false, false);
  assert.equal(result.errorCode, 'CANCELLED');
});

it('#9577 N1 mutation_batch stops before the next op and reports the completed op', async () => {
  const m = await model('batch-abort.ifc');
  const controller = new AbortController();
  const result = await dispatch(m, 'mutation_batch', { operations: [
    { tool: 'viewer_open' },
    { tool: 'entity_set_attribute', args: { express_id: 1, attribute: 'Name', value: 'Forbidden' } },
  ] }, { signal: controller.signal, openViewerPanel: () => controller.abort() });
  assert.equal(m.backend.getMutationView()?.hasPendingChanges() ?? false, false);
  const data = result.structured as { passed: number; results: Array<{ ok: boolean }> };
  assert.equal(data.passed, 1);
  assert.equal(data.results[0].ok, true, 'the completed first op remains successful');
});

for (const phase of ['init', 'source', 'mesh'] as const) it(`#9577 N1 clash cancellation after ${phase} releases the mesher`, async t => {
  const m = await model(`clash-${phase}.ifc`);
  const controller = new AbortController();
  let processes = 0, disposed = 0;
  t.mock.method(GeometryProcessor.prototype, 'init', async () => { if (phase === 'init') controller.abort(); });
  let views = 0;
  const getView = m.backend.getMutationView.bind(m.backend);
  t.mock.method(m.backend, 'getMutationView', () => { if (++views === 2 && phase === 'source') controller.abort(); return getView(); });
  t.mock.method(GeometryProcessor.prototype, 'process', async () => {
    processes++;
    if (phase === 'mesh') controller.abort();
    return { meshes: [] } as unknown as GeometryResult;
  });
  t.mock.method(GeometryProcessor.prototype, 'dispose', () => { disposed++; });
  const result = await dispatch(m, 'clash_check', {}, { signal: controller.signal });
  assert.equal(result.errorCode, 'CANCELLED');
  assert.equal(processes, phase === 'mesh' ? 1 : 0);
  assert.equal(views, phase === 'init' ? 1 : 2, 'cancelled initialization cannot begin source preparation');
  assert.equal(disposed, 1);
});

for (const [tool, method, args] of [
  ['bsdd_search', 'search', { query: 'probe' }],
  ['bsdd_class', 'fetchClassInfo', { ifc_type: 'IfcWall' }],
  ['bsdd_property_sets', 'getPropertySets', { ifc_type: 'IfcWall' }],
  ['bsdd_match', 'searchRelatedClasses', { express_id: 1 }],
] as const) it(`#9577 N1 ${tool} observes cancellation after its lookup`, async t => {
  const m = await model(`${tool}.ifc`);
  const controller = new AbortController();
  // This represents a completed network lookup that did not support transport abort.
  if (method === 'fetchClassInfo') t.mock.method(BsddNamespace.prototype, method, async () => { controller.abort(); return null; });
  else if (method === 'getPropertySets') t.mock.method(BsddNamespace.prototype, method, async () => { controller.abort(); return new Map(); });
  else t.mock.method(BsddNamespace.prototype, method, async () => { controller.abort(); return []; });
  const result = await dispatch(m, tool, args, { signal: controller.signal });
  assert.equal(result.errorCode, 'CANCELLED');
});

it('#9577 N1 stopping a selection wait releases its subscription immediately', async () => {
  const { advance } = await import('@/test/render');
  const controller = new AbortController();
  let listener: (hits: Array<{ expressId: number }>) => void = () => undefined;
  let unsubscribed = 0, settled = false;
  const viewer = selectionViewer(onSelection => { listener = onSelection; return () => { unsubscribed++; }; });
  const pending = dispatch(await model('selection-abort.ifc'), 'viewer_wait_for_selection', {}, { viewer, signal: controller.signal });
  void pending.then(() => { settled = true; });
  listener([]);
  await advance(0);
  assert.equal(settled, false, 'deselecting is not a selection');
  controller.abort();
  await advance(0);
  const immediate = settled;
  if (!settled) listener([{ expressId: 1 }]); // Settle the baseline/removed-guard path too.
  const result = await pending;
  listener([{ expressId: 1 }]); // Ignore an already queued event after teardown.
  assert.equal(immediate, true, 'Stop does not wait for a selection or timeout');
  assert.equal(unsubscribed, 1);
  assert.equal(result.errorCode, 'CANCELLED');
});

for (const phase of ['progress', 'validation'] as const) it(`#9577 N1 IDS checks cancellation at ${phase} without staging a report`, async t => {
  const m = await model(`ids-${phase}.ifc`);
  const controller = new AbortController();
  t.after(() => playgroundFiles.clear());
  const view = m.backend.getMutationView.bind(m.backend);
  if (phase === 'progress') t.mock.method(m.backend, 'getMutationView', () => { controller.abort(); return view(); });
  const getEntry = m.store.entityIndex.byId.get.bind(m.store.entityIndex.byId);
  let reads = 0;
  t.mock.method(m.store.entityIndex.byId, 'get', (id: number) => { reads++; if (phase === 'validation') controller.abort(); return getEntry(id); });
  const before = playgroundFiles.list().length;
  const result = await dispatch(m, 'ids_validate', { ids_xml: `<ids xmlns="http://standards.buildingsmart.org/IDS"><info><title>Cancellation</title></info><specifications><specification name="s" ifcVersion="IFC4"><applicability><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability><requirements><attribute><name><simpleValue>Name</simpleValue></name><value><simpleValue>Wall A</simpleValue></value></attribute></requirements></specification></specifications></ids>` }, { signal: controller.signal });
  assert.equal(result.errorCode, 'CANCELLED');
  assert.equal(playgroundFiles.list().length, before, 'cancelled validation does not publish a report');
  if (phase === 'progress') assert.equal(reads, 0, 'the progress checkpoint stops validation before reading entity requirements');
  else assert.equal(reads > 0, true, 'the cancellation was raised inside validation');
});

for (const tool of ['clash_check', 'clash_matrix', 'clash_bcf_export'] as const) it(`#9577 N1 ${tool} forwards cancellation into the clash engine`, async t => {
  const { createClashEngine } = await import('@ifc-lite/clash');
  const controller = new AbortController();
  const engine = createClashEngine({ backend: 'ts' });
  const prototype = Object.getPrototypeOf(engine) as typeof engine;
  const run = engine.run.bind(engine);
  t.mock.method(GeometryProcessor.prototype, 'init', async () => undefined);
  t.mock.method(GeometryProcessor.prototype, 'dispose', () => undefined);
  t.mock.method(GeometryProcessor.prototype, 'process', async () => ({ meshes: [{
    expressId: 1, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1],
  }] }) as unknown as GeometryResult);
  t.mock.method(prototype, 'run', async (elements: ClashElement[], rules: ClashRule[], settings?: ClashSettings) => {
    controller.abort();
    settings?.signal?.throwIfAborted();
    return run(elements, rules, settings);
  });
  const result = await dispatch(await model(`engine-${tool}.ifc`), tool, {}, { signal: controller.signal });
  assert.equal(result.errorCode, 'CANCELLED', 'the engine observes the actual run signal');
});

function selectionViewer(subscribeSelection: import('./playground-viewer-types').ViewerController['subscribeSelection']): import('./playground-viewer-types').ViewerController {
  return {
    isLoaded: () => true, status: () => ({ loaded: true, meshCount: 1, selection: [], webglUnavailable: false }),
    colorize: () => ({ count: 0 }), isolate: () => ({ count: 0 }), hide: () => ({ count: 0 }), show: () => ({ count: 0 }),
    reset: () => undefined, flyTo: () => ({ count: 0 }), setSection: () => undefined, clearSection: () => undefined,
    colorByStorey: () => ({ groups: 0 }), colorByProperty: () => ({ legend: [] }), getSelection: () => [],
    setOnSelectionChange: () => undefined,
    subscribeSelection,
  };
}

for (const event of ['selection', 'abort'] as const) it(`#9577 N1 selection wait cleans up a synchronous ${event}`, async () => {
  const controller = new AbortController();
  let unsubscribed = 0;
  const viewer = selectionViewer(listener => {
    if (event === 'selection') listener([{ expressId: 1 }]);
    else controller.abort();
    return () => { unsubscribed++; };
  });
  const result = await dispatch(await model(`selection-sync-${event}.ifc`), 'viewer_wait_for_selection', { timeout_ms: 500 }, { viewer, signal: controller.signal });
  assert.equal(unsubscribed, 1);
  assert.equal(result.isError, event === 'abort');
  if (event === 'abort') assert.equal(result.errorCode, 'CANCELLED');
});

it('#9577 N1 a completed selection removes the abort listener before later Stop', async t => {
  const controller = new AbortController();
  let listener: (hits: Array<{ expressId: number }>) => void = () => undefined;
  let unsubscribed = 0;
  const viewer = selectionViewer(onSelection => { listener = onSelection; return () => { unsubscribed++; }; });
  const removed = t.mock.method(controller.signal, 'removeEventListener');
  const pending = dispatch(await model('selection-complete.ifc'), 'viewer_wait_for_selection', {}, { viewer, signal: controller.signal });
  listener([{ expressId: 1 }]);
  const result = await pending;
  const removals = removed.mock.calls.filter(call => call.arguments[0] === 'abort').length;
  controller.abort();
  listener([{ expressId: 2 }]);
  assert.equal(result.isError, false);
  assert.equal(removals, 1, 'completed waits do not retain the run signal listener');
  assert.equal(unsubscribed, 1, 'a late abort or queued selection cannot tear down twice');
});
