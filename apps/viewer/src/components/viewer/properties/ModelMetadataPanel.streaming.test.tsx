/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #6411: the model statistics walk every mesh to count "Elements with
 * Geometry". While geometry streams, each publish hands the panel a model
 * with more meshes, twice a second on a large load, so the count follows the
 * streaming refresh cadence instead and is exact once streaming ends.
 */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { act, useState } from 'react';
import { expireStoreBusyCap, settleLoadWindow, untilReleased } from '@/test/load-window';
import { markModelLoadEnded } from '@/hooks/modelLoadEnd';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { GeometryResult, MeshData } from '@ifc-lite/geometry';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore, type FederatedModel } from '@/store';
import { ModelMetadataPanel } from './ModelMetadataPanel';

afterEach(async () => {
  cleanup();
  mock.restoreAll();
  useViewerStore.setState({ geometryStreamingActive: false, loading: false, models: new Map() });
  await settleLoadWindow(); // the next test starts with the window closed
});

const STEP = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#2=IFCSITE('0Site000000000000000aa',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#3=IFCBUILDING('0Building000000000000a',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);
#4=IFCBUILDINGSTOREY('0Storey00000000000000a',$,'00',$,$,$,$,$,.ELEMENT.,0.);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$);
#6=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',());
#7=IFCPRODUCTDEFINITIONSHAPE($,$,(#6));
#10=IFCWALL('0Wall10000000000000000',$,'W1',$,$,$,#7,$,$);
#11=IFCWALL('0Wall11000000000000000',$,'W2',$,$,$,#7,$,$);
#12=IFCWALL('0Wall12000000000000000',$,'W3',$,$,$,#7,$,$);
#20=IFCRELAGGREGATES('0Agg200000000000000000',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('0Agg210000000000000000',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('0Agg220000000000000000',$,$,$,#3,(#4));
#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont30000000000000000',$,$,$,(#10,#11,#12),#4);
ENDSEC;
END-ISO-10303-21;`;

function geometry(ids: readonly number[]): GeometryResult {
  const meshes = ids.map((expressId) => ({
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  }) as MeshData);
  return { meshes, totalTriangles: ids.length, totalVertices: ids.length * 3 } as GeometryResult;
}

async function parse(): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(STEP);
  return new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
}

/** The value cell of the row labelled `label` (InspectorRow: label span, then value span), or a not-found marker. */
function rowValue(panel: HTMLElement, label: string): string {
  const labelCell = [...panel.querySelectorAll('span[title]')].find((el) => el.getAttribute('title') === label);
  const value = labelCell?.nextElementSibling;
  return value ? (value.textContent ?? '').trim() : `<no "${label}" row in ${JSON.stringify(panel.textContent)}>`;
}
/** The value of the "Elements with Geometry" row, read from that row only. */
const elementsWithGeometry = (panel: HTMLElement): string => rowValue(panel, 'Elements with Geometry');
/** The value of the "Building Storeys" row, read from that row only. */
const buildingStoreys = (panel: HTMLElement): string => rowValue(panel, 'Building Storeys');

it('shows a dash while the load window is open and the exact counts once it settles (load window; supersedes #6411)', async () => {
  const dataStore = await parse();
  const model = (ids: number[]) => ({
    id: 'legacy', name: 'M', ifcDataStore: dataStore, geometryResult: geometry(ids),
    loadState: 'streaming-geometry', fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  useViewerStore.setState({ geometryStreamingActive: true, mutationViews: new Map(), mutationVersion: 0 });

  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model([10]));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  assert.equal(elementsWithGeometry(panel), '—', 'early read: placeholder, never a provisional count');
  assert.equal(buildingStoreys(panel), '—');

  act(() => setModel(model([10, 11, 12])));
  assert.equal(elementsWithGeometry(panel), '—', 'a publish inside the window computes nothing');

  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  await settleLoadWindow();
  assert.equal(elementsWithGeometry(panel), '3', 'settled: the exact count');
  assert.equal(buildingStoreys(panel), '1');
});

it('a federated add holds only the loading model: settled model A keeps its statistics, B\'s appear at its settle', async () => {
  const dataStore = await parse();
  const { registerModelOffset } = useViewerStore.getState();
  const offsetA = registerModelOffset('panel-A', 100);
  const offsetB = registerModelOffset('panel-B', 100);
  const model = (id: string, offset: number, ids: number[], loadState: FederatedModel['loadState']) => ({
    id, name: id, ifcDataStore: dataStore, geometryResult: geometry(ids.map((x) => x + offset)), loadState,
    idOffset: offset, maxExpressId: 100, fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  const a = model('panel-A', offsetA, [10, 11], 'complete');
  useViewerStore.setState({ models: new Map([['panel-A', a]]), mutationViews: new Map(), mutationVersion: 0 });
  const panelA = render(<ModelMetadataPanel model={a} />);
  assert.equal(elementsWithGeometry(panelA), '2', 'A settled: its count');
  assert.equal(buildingStoreys(panelA), '1');

  act(() => useViewerStore.setState({ loading: true }));
  const bLoading = model('panel-B', offsetB, [10, 11, 12], 'pending');
  act(() => useViewerStore.setState({ models: new Map([['panel-A', a], ['panel-B', bLoading]]), geometryStreamingActive: true }));
  assert.equal(elementsWithGeometry(panelA), '2', 'A keeps its statistics while B loads');
  const panelB = render(<ModelMetadataPanel model={bLoading} />);
  assert.equal(elementsWithGeometry(panelB), '—', 'B is held while it loads');

  act(() => useViewerStore.setState({ geometryStreamingActive: false, loading: false }));
  await settleLoadWindow();
  assert.equal(elementsWithGeometry(panelB), '3', 'B settled: its count');
  assert.equal(elementsWithGeometry(panelA), '2');
});

// Main's streaming-hold tests (#6411), unchanged but for the start: inside a
// load window a loading model is held outright, and the throttle still governs
// a stream that outlives the store-busy limit, so they start after it expired.
it('holds "Elements with Geometry" while streaming and shows the exact count when streaming ends (#6411)', async () => {
  let clock = 0;
  mock.method(performance, 'now', () => clock);
  const dataStore = await parse();
  const model = (ids: number[]) => ({
    id: 'legacy', name: 'M', ifcDataStore: dataStore, geometryResult: geometry(ids),
    loadState: 'streaming-geometry', fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  useViewerStore.setState({ mutationViews: new Map(), mutationVersion: 0 });

  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model([10]));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  await expireStoreBusyCap(() => useViewerStore.setState({ geometryStreamingActive: true }), (ms) => { clock = ms; });
  assert.equal(elementsWithGeometry(panel), '1');

  clock += 1;
  act(() => setModel(model([10, 11, 12])));
  assert.equal(elementsWithGeometry(panel), '1', 'a publish within the refresh window is held');

  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  assert.equal(elementsWithGeometry(panel), '3', 'streaming ended: the exact count');
});

it('holds only this model\'s own streaming geometry: another model or this one finishing passes at once (#6411)', async () => {
  let clock = 0;
  mock.method(performance, 'now', () => clock);
  const dataStore = await parse();
  const model = (id: string, ids: number[], loadState: FederatedModel['loadState']) => ({
    id, name: id, ifcDataStore: dataStore, geometryResult: geometry(ids), loadState, fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  useViewerStore.setState({ mutationViews: new Map(), mutationVersion: 0 });

  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model('legacy', [10], 'streaming-geometry'));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  // The global flag stays on throughout: another federated model is still streaming.
  await expireStoreBusyCap(() => useViewerStore.setState({ geometryStreamingActive: true }), (ms) => { clock = ms; });
  assert.equal(elementsWithGeometry(panel), '1');

  clock += 1;
  act(() => setModel(model('legacy', [10, 11], 'complete')));
  assert.equal(elementsWithGeometry(panel), '2', 'this model finished: its exact count, although another model still streams');

  clock += 1;
  act(() => setModel(model('default', [10, 11, 12], 'streaming-geometry')));
  assert.equal(elementsWithGeometry(panel), '3', 'a different model never shows the previous model\'s held geometry');
});

it('computes the statistics against the FINAL store after a store swap inside the window', async () => {
  const full = await parse();
  const partialBytes = new TextEncoder().encode(STEP.replace("#12=IFCWALL('0Wall12000000000000000',$,'W3',$,$,$,#7,$,$);\n", '').replace('(#10,#11,#12),#4', '(#10,#11),#4'));
  const partial = await new IfcParser().parseColumnar(partialBytes.buffer, { disableWorkerScan: true });
  const model = (ds: IfcDataStore, loadState: FederatedModel['loadState']) => ({
    id: 'legacy', name: 'M', ifcDataStore: ds, geometryResult: geometry([10, 11, 12]), loadState, fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  useViewerStore.setState({ loading: true, mutationViews: new Map(), mutationVersion: 0 });
  let setModel: (m: FederatedModel) => void = () => {};
  function Host() {
    const [current, set] = useState(model(partial, 'hydrating-metadata'));
    setModel = set;
    return <ModelMetadataPanel model={current} />;
  }
  const panel = render(<Host />);
  assert.equal(elementsWithGeometry(panel), '—');
  act(() => setModel(model(full, 'complete')));
  assert.equal(elementsWithGeometry(panel), '—', 'the swap inside the window computes nothing');
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(elementsWithGeometry(panel), '3', 'settled: the final store\'s three walls (the partial store has two)');
});

it('multi-file open: A\'s statistics appear at A\'s settle while B, started at once, is held', async () => {
  const dataStore = await parse();
  const { registerModelOffset } = useViewerStore.getState();
  const offsetA = registerModelOffset('seq-A', 100);
  const offsetB = registerModelOffset('seq-B', 100);
  const model = (id: string, offset: number, loadState: FederatedModel['loadState']) => ({
    id, name: id, ifcDataStore: dataStore, geometryResult: geometry([10, 11].map((x) => x + offset)), loadState,
    idOffset: offset, maxExpressId: 100, fileSize: 1, loadedAt: 0,
  }) as FederatedModel;
  act(() => useViewerStore.setState({ loading: true, mutationViews: new Map(), mutationVersion: 0, models: new Map([['seq-A', model('seq-A', offsetA, 'pending')]]) }));
  const aDone = model('seq-A', offsetA, 'complete');
  const panelA = render(<ModelMetadataPanel model={aDone} />);
  act(() => useViewerStore.setState({ models: new Map([['seq-A', aDone]]) }));
  act(() => markModelLoadEnded('seq-A'));
  act(() => useViewerStore.setState({ models: new Map([['seq-A', aDone], ['seq-B', model('seq-B', offsetB, 'pending')]]) }));
  const panelB = render(<ModelMetadataPanel model={model('seq-B', offsetB, 'pending')} />);
  await settleLoadWindow(await untilReleased('seq-A'));
  assert.equal(useViewerStore.getState().loading, true);
  assert.equal(elementsWithGeometry(panelA), '2', 'A settled: its statistics, although B is loading');
  assert.equal(elementsWithGeometry(panelB), '—', 'B is held');
});

for (const path of ['cache hit', 'cold load'] as const) {
  it(`single-model ${path}: no statistics between the record turning complete and the UI settle`, async () => {
    const dataStore = await parse();
    const offset = useViewerStore.getState().registerModelOffset(`one-${path}`, 100);
    const id = `one-${path}`;
    const model = (loadState: FederatedModel['loadState']) => ({
      id, name: id, ifcDataStore: dataStore, geometryResult: geometry([10, 11].map((x) => x + offset)), loadState,
      idOffset: offset, maxExpressId: 100, fileSize: 1, loadedAt: 0,
    }) as FederatedModel;
    act(() => useViewerStore.setState({ loading: true, mutationViews: new Map(), mutationVersion: 0, models: new Map([[id, model('pending')]]) }));
    if (path === 'cold load') act(() => useViewerStore.setState({ models: new Map([[id, model('streaming-geometry')]]) }));
    const done = model('complete');
    act(() => useViewerStore.setState({ models: new Map([[id, done]]) }));
    const panel = render(<ModelMetadataPanel model={done} />);
    await settleLoadWindow(); await settleLoadWindow();
    assert.equal(elementsWithGeometry(panel), '—', 'record complete, UI not settled: held');
    act(() => { useViewerStore.setState({ loading: false }); markModelLoadEnded(id); });
    await settleLoadWindow();
    assert.equal(elementsWithGeometry(panel), '2');
  });
}
