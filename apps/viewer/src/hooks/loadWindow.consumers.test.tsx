/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whole-model consumers wait for the load window (loadWindow.ts): an early
 * read gets the placeholder and computes nothing; after settle they hold the
 * exact values. (StatusBar, ModelMetadataPanel and drawing-markup restore have
 * their own cases next to their existing tests.)
 */

import '@/test/setup-dom.js';
import { afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { markModelLoadEnded } from './modelLoadEnd.js';
import { settleLoadWindow } from '@/test/load-window';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { render, cleanup } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useSymbolicActiveStores } from './useSymbolicActiveStores.js';
import { useViewportStatusSummary } from './useViewportStatusSummary.js';

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
#20=IFCRELAGGREGATES('0Agg200000000000000000',$,$,$,#1,(#2));
#21=IFCRELAGGREGATES('0Agg210000000000000000',$,$,$,#2,(#3));
#22=IFCRELAGGREGATES('0Agg220000000000000000',$,$,$,#3,(#4));
#30=IFCRELCONTAINEDINSPATIALSTRUCTURE('0Cont30000000000000000',$,$,$,(#10,#11),#4);
ENDSEC;
END-ISO-10303-21;`;

async function parse(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer, { disableWorkerScan: true });
}

afterEach(async () => {
  cleanup();
  useViewerStore.setState({ geometryStreamingActive: false, loading: false, hiddenEntities: new Set(), models: new Map(), activeModelId: null });
  await settleLoadWindow(); // the next test starts with the window closed
});

const federated = (id: string, store: IfcDataStore, loadState: string) => ({
  id, name: id, ifcDataStore: store, geometryResult: null, visible: true, collapsed: false,
  idOffset: 0, maxExpressId: 100, loadState, fileSize: 1, loadedAt: 0,
}) as never;

it('symbolic overlays get no stores while the load window is open, and the loaded store once it settles', async () => {
  const store = await parse();
  useViewerStore.setState({ ifcDataStore: store, models: new Map(), geometryResult: null, geometryStreamingActive: true });
  let seen: number[] = [];
  function Probe() { seen.push(useSymbolicActiveStores().length); return null; }
  render(<Probe />);
  assert.ok(seen.length > 0 && seen.every((n) => n === 0), `early read: no store reaches the overlay parse (saw ${seen})`);
  seen = [];
  act(() => useViewerStore.setState({ geometryStreamingActive: false }));
  await settleLoadWindow();
  assert.equal(seen.at(-1), 1, 'settled: the overlays parse the loaded store');
});

it('viewport status summary skips the whole-model walk in the window and counts exactly after settle', async () => {
  const store = await parse();
  useViewerStore.setState({
    ifcDataStore: store, models: new Map(), geometryResult: null, mutationViews: new Map(), mutationVersion: 0,
    hiddenEntities: new Set([10]), loading: true,
  });
  let hidden: number[] = [];
  function Probe() { hidden.push(useViewportStatusSummary().objectCounts.hidden); return null; }
  render(<Probe />);
  assert.ok(hidden.every((n) => n === 0), `early read: no count, and none is shown at zero (saw ${hidden})`);
  hidden = [];
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(hidden.at(-1), 1, 'settled: the hidden wall is counted');
});

it('exports the same window for non-React consumers (the after-load queue)', async () => {
  const mod = (await import('./loadWindow.js')) as Record<string, unknown>;
  assert.equal(typeof mod.viewerLoadWindow, 'function', 'loadWindow.ts must export viewerLoadWindow');
  const win = (mod.viewerLoadWindow as () => { isOpen(): boolean; isHeld(id: string): boolean; subscribe(l: () => void): () => void })();
  assert.equal(typeof win.isHeld, 'function', 'per-model hold for non-React consumers');
  assert.equal(win, (mod.viewerLoadWindow as () => unknown)(), 'one singleton');
  const seen: boolean[] = [];
  const unsubscribe = win.subscribe(() => seen.push(win.isOpen()));
  act(() => useViewerStore.setState({ loading: true }));
  assert.equal(win.isOpen(), true, 'opens with a load');
  assert.equal(win.isHeld('legacy'), true, 'single-store mode: the store being loaded is held');
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(win.isOpen(), false, 'closes after the settled frame');
  assert.deepEqual(seen, [true, false]);
  unsubscribe();
});

it('symbolic overlays keep settled model A\'s store while B loads, and add B\'s at its settle', async () => {
  const storeA = await parse(), storeB = await parse();
  useViewerStore.setState({ ifcDataStore: storeA, models: new Map([['A', federated('A', storeA, 'complete')]]) });
  let seen: string[][] = [];
  function Probe() { seen.push(useSymbolicActiveStores().map((s) => s.modelId)); return null; }
  render(<Probe />);
  assert.deepEqual(seen.at(-1), ['A']);
  seen = [];
  act(() => useViewerStore.setState({ loading: true }));
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')], ['B', federated('B', storeB, 'pending')]]), geometryStreamingActive: true }));
  assert.ok(seen.length > 0 && seen.every((ids) => ids.join() === 'A'), `A's overlays never withdrawn, B not parsed yet (saw ${JSON.stringify(seen)})`);
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')], ['B', federated('B', storeB, 'complete')]]), geometryStreamingActive: false, loading: false }));
  await settleLoadWindow();
  assert.deepEqual(seen.at(-1), ['A', 'B'], 'settled: B\'s overlays join');
});

it('symbolic overlays parse the FINAL store after a store swap inside the window', async () => {
  const partial = await parse(), full = await parse();
  useViewerStore.setState({ ifcDataStore: partial, models: new Map(), geometryResult: null, loading: true });
  let seen: Array<IfcDataStore | undefined> = [];
  function Probe() { seen.push(useSymbolicActiveStores()[0]?.store); return null; }
  render(<Probe />);
  act(() => useViewerStore.setState({ ifcDataStore: full }));
  assert.equal(seen.filter((s) => s !== undefined).length, 0, 'nothing parsed inside the window');
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(seen.at(-1), full, 'settled: the final store, never the partial one');
  assert.ok(!seen.includes(partial));
});

it('viewport status summary keeps settled model A\'s hidden pill while B loads', async () => {
  const storeA = await parse(), storeB = await parse();
  useViewerStore.setState({
    ifcDataStore: storeA, activeModelId: 'A', models: new Map([['A', federated('A', storeA, 'complete')]]),
    mutationViews: new Map(), mutationVersion: 0, hiddenEntities: new Set([10]),
  });
  let hidden: number[] = [];
  function Probe() { hidden.push(useViewportStatusSummary().objectCounts.hidden); return null; }
  render(<Probe />);
  assert.equal(hidden.at(-1), 1);
  hidden = [];
  act(() => useViewerStore.setState({ loading: true }));
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')], ['B', federated('B', storeB, 'pending')]]), geometryStreamingActive: true }));
  assert.ok(hidden.length > 0 && hidden.every((n) => n === 1), `A's pill stays while B loads (saw ${hidden})`);
});

it('viewport status summary counts against the FINAL store after a swap inside the window', async () => {
  const partial = await parse();
  const full = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP.replace(
    "#30=IFCRELCONTAINEDINSPATIALSTRUCTURE",
    "#12=IFCWALL('0Wall12000000000000000',$,'W3',$,$,$,#7,$,$);\n#30=IFCRELCONTAINEDINSPATIALSTRUCTURE",
  ).replace('(#10,#11),#4', '(#10,#11,#12),#4')).buffer, { disableWorkerScan: true });
  useViewerStore.setState({
    ifcDataStore: partial, models: new Map(), geometryResult: null, mutationViews: new Map(), mutationVersion: 0,
    hiddenEntities: new Set([10, 12]), loading: true,
  });
  let hidden: number[] = [];
  function Probe() { hidden.push(useViewportStatusSummary().objectCounts.hidden); return null; }
  render(<Probe />);
  act(() => useViewerStore.setState({ ifcDataStore: full }));
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(hidden.at(-1), 2, 'settled: both hidden walls of the final store (the partial store has only one)');
});

it('multi-file open: A\'s overlays and hidden pill appear at A\'s settle while B, started at once, is held', async () => {
  const storeA = await parse(), storeB = await parse();
  useViewerStore.setState({ mutationViews: new Map(), mutationVersion: 0, hiddenEntities: new Set([10]), activeModelId: 'A' });
  let overlays: string[][] = [];
  let hidden: number[] = [];
  function Probe() {
    overlays.push(useSymbolicActiveStores().map((x) => x.modelId));
    hidden.push(useViewportStatusSummary().objectCounts.hidden);
    return null;
  }
  // loadFilesSequentially: file A starts the window.
  act(() => useViewerStore.setState({ loading: true, ifcDataStore: storeA, models: new Map([['A', federated('A', storeA, 'pending')]]) }));
  render(<Probe />);
  assert.deepEqual(overlays.at(-1), [], 'A is loading: held');
  // A finishes and file B starts at once; the store never stops loading.
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')]]) }));
  act(() => markModelLoadEnded('A')); // A's settleLoadUi
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')], ['B', federated('B', storeB, 'pending')]]) }));
  await settleLoadWindow();
  assert.equal(useViewerStore.getState().loading, true, 'B is still loading');
  assert.deepEqual(overlays.at(-1), ['A'], 'A settled: its overlays appear; B is held');
  assert.equal(hidden.at(-1), 1, 'A\'s hidden pill appears');
  act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')], ['B', federated('B', storeB, 'complete')]]), loading: false }));
  await settleLoadWindow();
  assert.deepEqual(overlays.at(-1), ['A', 'B']);
});

for (const path of ['cache hit', 'cold load'] as const) {
  it(`single-model ${path}: overlays and the hidden pill compute nothing between the record turning complete and the UI settle`, async () => {
    const storeA = await parse();
    useViewerStore.setState({ mutationViews: new Map(), mutationVersion: 0, hiddenEntities: new Set([10]), activeModelId: 'A' });
    let overlays: string[][] = [];
    let hidden: number[] = [];
    function Probe() {
      overlays.push(useSymbolicActiveStores().map((x) => x.modelId));
      hidden.push(useViewportStatusSummary().objectCounts.hidden);
      return null;
    }
    act(() => useViewerStore.setState({ loading: true, ifcDataStore: storeA, models: new Map([['A', federated('A', storeA, 'pending')]]) }));
    render(<Probe />);
    if (path === 'cold load') {
      act(() => useViewerStore.setState({ geometryStreamingActive: true, models: new Map([['A', federated('A', storeA, 'streaming-geometry')]]) }));
      act(() => useViewerStore.setState({ geometryStreamingActive: false }));
    }
    // Finalize publication: the record reads complete; the metadata decode and the UI settle follow.
    act(() => useViewerStore.setState({ models: new Map([['A', federated('A', storeA, 'complete')]]) }));
    overlays = []; hidden = [];
    await settleLoadWindow(); await settleLoadWindow();
    assert.ok(overlays.every((ids) => ids.length === 0), `no overlay store before the UI settle (saw ${JSON.stringify(overlays)})`);
    assert.ok(hidden.every((n) => n === 0), `no hidden-pill walk before the UI settle (saw ${hidden})`);
    // settleLoadUi: loading clears and the loader marks A's load as ended.
    act(() => { useViewerStore.setState({ loading: false }); markModelLoadEnded('A'); });
    await settleLoadWindow();
    assert.deepEqual(overlays.at(-1), ['A'], 'after the settled frame');
    assert.equal(hidden.at(-1), 1);
  });
}
