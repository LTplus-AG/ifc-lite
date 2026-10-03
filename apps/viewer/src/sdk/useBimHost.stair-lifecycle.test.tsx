/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232: the mounted public BimProvider must supply a writable canonical store. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { EntityExtractor, IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import type { BimContext, EntityRef } from '@ifc-lite/sdk';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { seedModelingSession } from '@/test/modeling-session-fixture';
import { remeshOnApi, styleWireOnApi } from '../../../../packages/geometry/src/remesh/remesh-core.js';
import { requestRemesh, setRemeshClientFactory } from '@/lib/remesh/remesh-service';
import { toGlobalIdFromModels } from '@/store/globalId';
import { cleanup, render } from '@/test/render';
import { BimProvider, useBim } from './BimProvider';

const SAMPLE = new URL('../../public/samples/hello-wall.ifc', import.meta.url);
const WASM = new URL('../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const MODEL = 'bonsai';
afterEach(() => { cleanup(); setRemeshClientFactory(null); });
function bytes(modelId = MODEL) {
  const state = useViewerStore.getState(), model = state.models.get(modelId)!;
  return new StepExporter(model.ifcDataStore!, state.mutationViews.get(modelId)).export({ schema: 'IFC4', applyMutations: true }).content;
}
async function records(content: Uint8Array) {
  const parsed = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const extractor = new EntityExtractor(parsed.source);
  return [...parsed.entityIndex.byId].map(([id, location]) => {
    const entity = extractor.extractEntity(location);
    assert.ok(entity, `Actual IFC record #${id} decodes`);
    return [id, entity] as const;
  }).sort((a, b) => a[0] - b[0]);
}
for (const count of [1, 2] as const) it(`#6232 mounted BimProvider/${count} commits a stair pair, preserves refusal, and undoes public edits`, async t => {
  if (!existsSync(SAMPLE) || !existsSync(WASM)) { t.skip('Real Bonsai sample and WASM required; run pnpm fixtures and pnpm build'); return; }
  await seedModelingSession();
  const source = readFileSync(SAMPLE), models = new Map(useViewerStore.getState().models), views = new Map<string, MutablePropertyView>();
  models.clear();
  const geometry = useViewerStore.getState().geometryResult!;
  for (const [i, id] of [MODEL, 'peer'].slice(0, count).entries()) {
    const parsed = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { disableWorkerScan: true });
    models.set(id, { ...fixtureModel(id, { idOffset: count === 1 ? 0 : (i + 1) * 1_000_000 }), ifcDataStore: parsed,
      geometryResult: { ...geometry, meshes: [], coordinateInfo: { ...geometry.coordinateInfo, wasmRtcFrame: { x: 0, y: 0, z: 0, needsShift: false } } } });
    views.set(id, new MutablePropertyView(parsed.properties ?? null, id));
  }
  useViewerStore.setState({ ...fixtureModels(models.get(MODEL)!), models, activeModelId: MODEL,
    geometryResult: models.get(MODEL)!.geometryResult, mutationViews: views, storeEditors: new Map(),
    collabRoomId: null, collabRoomModels: new Map(), editEnabled: true });
  initSync({ module: readFileSync(WASM) });
  const api = new IfcAPI();
  try {
    setRemeshClientFactory(async () => ({ alive: true, dispose: () => {}, setConfig: () => {},
      styleWire: async content => styleWireOnApi(api, content), remesh: async request => remeshOnApi(api, request) }));
    const captured: { bim?: BimContext } = {};
    function Consumer() { captured.bim = useBim(); return null; }
    render(<BimProvider><Consumer /></BimProvider>);
    assert.ok(captured.bim, 'Mounted consumer obtains the actual provider-created context');
    const publicStore = captured.bim.store;
    const prior = await records(bytes()), peer = count === 2 ? await records(bytes('peer')) : null;
    let stair!: EntityRef;
    assert.doesNotThrow(() => {
      stair = publicStore.addStair(MODEL, 42, { Position: [1, 2, 0], NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 1 });
    }, 'Public provider context must commit through the canonical writable store');
    const created = await records(bytes());
    const aggregate = created.find(([, e]) => e.type === 'IFCRELAGGREGATES' && e.attributes[4] === stair.expressId);
    assert.ok(aggregate, 'Exported assembly has its actual IfcRelAggregates');
    const parts = aggregate[1].attributes[5];
    assert.ok(Array.isArray(parts) && typeof parts[0] === 'number');
    const flight = parts[0], global = toGlobalIdFromModels(models, MODEL, flight);
    assert.equal((await requestRemesh(useViewerStore.getState, MODEL, [flight], 'created')).status, 'applied');
    assert.ok(useViewerStore.getState().models.get(MODEL)!.geometryResult!.meshes.some(mesh => mesh.expressId === global && mesh.indices.length > 0), 'Real native flight mesh reaches canonical geometry');
    const view = views.get(MODEL)!, journal = view.getMutations(), next = view.peekNextExpressId();
    const stack = useViewerStore.getState().undoStacks.get(MODEL)!.length;
    assert.throws(() => publicStore.replaceElement(stair, 42, { kind: 'stair', params: { Position: [1, 2, 0], NumberOfRisers: 4, RiserHeight: .2, TreadLength: .3, Width: 0 } }));
    assert.deepEqual(await records(bytes()), created, 'Refusal preserves the real IFC graph');
    assert.deepEqual(view.getMutations(), journal);
    assert.equal(view.peekNextExpressId(), next);
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)!.length, stack);
    assert.equal(publicStore.removeStair(stair), true);
    assert.ok(!(await records(bytes())).some(([id]) => id === stair.expressId || id === flight), 'Public removal deletes both actual products');
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(await records(bytes()), created, 'ONE Undo restores the assembly and flight');
    assert.equal(useViewerStore.getState().undoStacks.get(MODEL)!.length, stack);
    useViewerStore.getState().undo(MODEL);
    assert.deepEqual(await records(bytes()), prior, 'ONE further Undo restores the imported model');
    if (peer) assert.deepEqual(await records(bytes('peer')), peer, 'Public writes leave the other real federated model unchanged');
  } finally { cleanup(); setRemeshClientFactory(null); api.free(); }
});
