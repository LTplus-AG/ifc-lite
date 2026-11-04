/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { computeIsolationFilterSet } from '@/store/basketVisibleSet.js';
import { __setOverlayWorkerFactoryForTest } from '@/lib/overlay-parse/index.js';
import { createEmptyFlatSymbolic, type FlatSymbolic } from '@/lib/overlay-parse/symbolic-flat.js';
import { __resetSymbolicAnnotationsCacheForTests } from './symbolic-parse-cache.js';
import { useSymbolicAnnotations, useSymbolicAnnotationsRichData } from './useSymbolicAnnotations.js';
import { symbolicLineVertexData } from './symbolic-line-channels.js';
const ANNOTATION_X = 1;
const GRID_X = 1000;
function annotationAndGrid(): FlatSymbolic {
  const f = createEmptyFlatSymbolic();
  f.typeNames = ['IfcAnnotation', 'IfcGridAxis'];

  f.polyPoints = Float32Array.from([ANNOTATION_X, 0, ANNOTATION_X, 1, GRID_X, 0, GRID_X, 1]);
  f.polyStart = Uint32Array.from([0, 2, 4]);
  f.polyOwner = Uint32Array.from([2, 3]);
  f.polyWorldY = Float32Array.from([NaN, NaN]);
  f.polyFlags = Uint8Array.from([0, 0]);
  f.polyType = Uint16Array.from([0, 1]);

  f.textContent = ['DIM', 'A'];
  f.textAlignment = ['center', 'center'];
  f.textX = Float32Array.from([ANNOTATION_X, GRID_X]);
  f.textY = Float32Array.from([0, 0]);
  f.textDirX = Float32Array.from([1, 1]);
  f.textDirY = Float32Array.from([0, 0]);
  f.textHeight = Float32Array.from([1, 1]);
  f.textTargetPx = Float32Array.from([0, 0]);
  f.textColor = new Float32Array(8);
  f.textOwner = Uint32Array.from([2, 3]);
  f.textWorldY = Float32Array.from([NaN, NaN]);
  f.textType = Uint16Array.from([0, 1]);

  f.fillPoints = Float32Array.from([1,0,1,1,2,1,1000,0,1000,1,1001,1]);
  f.fillPointStart = Uint32Array.from([0,6,12]);
  f.fillHoleStart = Uint32Array.from([0,0,0]);
  f.fillColor = new Float32Array(8);
  f.fillHatch = new Float32Array(8);
  f.fillOwner = Uint32Array.from([2,3]);
  f.fillWorldY = Float32Array.from([NaN,NaN]);
  f.fillFlags = Uint8Array.from([0,0]);
  f.fillType = Uint16Array.from([0,1]);
  return f;
}


let root: Root | undefined;
let container: HTMLDivElement;
let restore: ReturnType<typeof __setOverlayWorkerFactoryForTest>;
let latest = { lines: 0, grid: '', labels: '', fills: 0, textClip: '', fillClip: '' };
let visibility: { hidden?: ReadonlySet<number> | null; isolated?: ReadonlySet<number> | null } | undefined;
function Probe() {
  const lines = useSymbolicAnnotations({ enabled: true, visibility });
  const rich = useSymbolicAnnotationsRichData({ enabled: true, visibility });
  latest = { lines: symbolicLineVertexData(lines.annotation).length,
    grid: JSON.stringify(lines.grid), labels: rich.texts.map(t => t.content).join(','),
    fills: rich.fills.length, textClip: rich.texts.map(t => String(t.sectionClipped)).join(','),
    fillClip: rich.fills.map(t => String(t.sectionClipped)).join(',') };
  return null;
}
async function sample(next = visibility) {
  visibility = next;
  await act(async () => { root!.render(<Probe />); await new Promise(r => setTimeout(r, 20)); });
  await act(async () => { await new Promise(r => setTimeout(r, 20)); });
  return { ...latest };
}
beforeEach(() => {
  visibility = undefined;
  __resetSymbolicAnnotationsCacheForTests();
  restore = __setOverlayWorkerFactoryForTest(() => {
    const worker = { onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(r: { id: number }) { setTimeout(() => worker.onmessage?.({ data: { id: r.id, ok: true, flat: annotationAndGrid() } }), 0); }, terminate() {} };
    return worker as unknown as Worker;
  });
  const store = { source: { contentKey: 'visibility-8767', byteLength: 10, toTransferable: () => ({}) } } as unknown as IfcDataStore;
  useViewerStore.setState({ ifcDataStore: store, models: new Map(), hiddenEntities: new Set(), lensHiddenIds: new Set(), hostHiddenIfcTypes: null });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => {
  act(() => root!.unmount());
  container.remove();
  __setOverlayWorkerFactoryForTest(restore);
});
it('#8767 isolation filters annotation lines, texts and fills but preserves grid bytes and bubbles', async () => {
  const baseline = await sample({ isolated: null });
  assert.equal(baseline.lines, 6);
  assert.equal(baseline.labels, 'DIM,A');
  assert.equal(baseline.fills, 2);
  const excluded = await sample({ isolated: new Set([999]) });
  assert.equal(excluded.lines, 0);
  assert.equal(excluded.labels, 'A');
  assert.equal(excluded.fills, 1);
  assert.equal(excluded.grid, baseline.grid);
  const included = await sample({ isolated: new Set([2]) });
  assert.equal(included.lines, baseline.lines);
  assert.equal(included.labels, baseline.labels);
  assert.equal(included.fills, baseline.fills);
  const noIsolation = await sample({ isolated: null });
  assert.equal(noIsolation.lines, baseline.lines);
});
it('#8767 explicit hidden replaces store hides; lens hides still apply including grids', async () => {
  useViewerStore.setState({ hiddenEntities: new Set([2]) });
  assert.equal((await sample()).lines, 0);
  assert.equal((await sample({ hidden: new Set() })).lines, 6);
  assert.equal((await sample({ hidden: new Set([2]) })).fills, 1);
  assert.equal((await sample({ hidden: null })).lines, 6);
  const gridHidden = await sample({ hidden: new Set([3]) });
  assert.equal(gridHidden.labels, 'DIM');
  assert.equal(gridHidden.fills, 1);
  act(() => useViewerStore.setState({ lensHiddenIds: new Set([2,3]) }));
  const hidden = await sample({ hidden: new Set() });
  assert.equal(hidden.lines, 0);
  assert.equal(hidden.labels, '');
  assert.equal(hidden.fills, 0);
});
it('#8767 isolation uses each model global offset, retaining owner B only', async () => {
  const store = useViewerStore.getState().ifcDataStore!;
  useViewerStore.setState(fixtureModels(
    { ...fixtureModel('a', { idOffset: 1000 }), ifcDataStore: store },
    { ...fixtureModel('b', { idOffset: 2000 }), ifcDataStore: store },
  ));
  const s = await sample({ isolated: new Set([2002]) });
  assert.equal(s.lines, 6);
  assert.equal(s.labels, 'A,DIM,A');
  assert.equal(s.fills, 3);
});
it('#8767 section clipping flags distinguish annotations from grid references', async () => {
  const s = await sample();
  assert.equal(s.textClip, 'true,false');
  assert.equal(s.fillClip, 'true,false');
});
it('#8767 parsed storey containment keeps its annotation under storey solo', async () => {
  const step = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('annotation.ifc','2026-11-04T00:00:00',(),(),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0000000000000000000001',$,'Project',$,$,$,$,$,$);
#10=IFCBUILDINGSTOREY('0000000000000000000010',$,'Level',$,$,$,$,$,.ELEMENT.,0.);
#2=IFCANNOTATION('0000000000000000000002',$,'Contained annotation',$,$,$,$);
#4=IFCANNOTATION('0000000000000000000004',$,'Loose annotation',$,$,$,$);
#20=IFCRELAGGREGATES('0000000000000000000020',$,$,$,#1,(#10));
#21=IFCRELCONTAINEDINSPATIALSTRUCTURE('0000000000000000000021',$,$,$,(#2),#10);
ENDSEC;
END-ISO-10303-21;`;
  const bytes = new TextEncoder().encode(step);
  const parsed = await new IfcParser().parseColumnar(bytes.buffer, { disableWorkerScan: true });
  assert.equal(parsed.spatialHierarchy?.byStorey.get(10)?.includes(2), true);
  // Two models force the storey allowlist to use global ids.
  useViewerStore.setState({ ...fixtureModels({ ...fixtureModel('other'), ifcDataStore: null }, {
    ...fixtureModel('parsed', { idOffset: 1000 }), ifcDataStore: parsed,
  }), selectedStoreys: new Set([1010]), classFilter: null, isolatedEntities: null });
  const isolated = computeIsolationFilterSet(useViewerStore.getState());
  assert.equal(isolated?.has(1002), true);
  assert.equal(isolated?.has(1004), false);
  const s = await sample({ isolated });
  assert.equal(s.lines, 6);
  assert.equal(s.labels.includes('DIM'), true);
});
