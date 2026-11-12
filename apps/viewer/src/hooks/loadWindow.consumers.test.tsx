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

afterEach(() => {
  cleanup();
  useViewerStore.setState({ geometryStreamingActive: false, loading: false, hiddenEntities: new Set() });
});

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
  const win = (mod.viewerLoadWindow as () => { isOpen(): boolean; subscribe(l: () => void): () => void })();
  assert.equal(win, (mod.viewerLoadWindow as () => unknown)(), 'one singleton');
  const seen: boolean[] = [];
  const unsubscribe = win.subscribe(() => seen.push(win.isOpen()));
  act(() => useViewerStore.setState({ loading: true }));
  assert.equal(win.isOpen(), true, 'opens with a load');
  act(() => useViewerStore.setState({ loading: false }));
  await settleLoadWindow();
  assert.equal(win.isOpen(), false, 'closes after the settled frame');
  assert.deepEqual(seen, [true, false]);
  unsubscribe();
});
