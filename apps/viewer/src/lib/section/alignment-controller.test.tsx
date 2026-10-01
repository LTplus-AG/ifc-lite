/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { IfcParser, sourceBytesFromTransferable } from '@ifc-lite/parser';
import type { AlignmentAxisJs } from '@ifc-lite/wasm';
let AxisConstructor: typeof import('@ifc-lite/wasm').AlignmentAxisJs;
import { MutablePropertyView } from '@ifc-lite/mutations';
import { configureMutationView } from '@/utils/configureMutationView';
import { act } from 'react';
import { render, cleanup, click, advance, press } from '@/test/render';
import { ViewportHud } from '@/components/viewport-ui/hud/ViewportHud';
import { ToolOverlays } from '@/components/viewer/ToolOverlays';
import { SceneOverlayRoot } from '@/components/viewport-ui/scene';
import { SectionToolbar } from '@/components/viewer/tools/SectionToolbar';
import { useViewerStore } from '@/store';
import { fixtureModel, fixtureModels } from '@/test/store-fixture';
import { bindAlignment, chooseAlignmentMode, startAlignmentTool, useAlignmentToolState, setAlignmentDistance } from './alignment-controller';
import type { AlignmentRequest, AlignmentResponse } from './alignment-contract';
import type { AlignmentWorker } from './alignment-client';
import type { GeometryResult } from '@ifc-lite/geometry';

const content = `ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCCARTESIANPOINT((0.,0.,0.));#11=IFCCARTESIANPOINT((10000.,0.,1000.));
#12=IFCPOLYLINE((#10,#11));#20=IFCALIGNMENT('axis-global-id',$,'Road',$,$,$,$,#12);ENDSEC;END-ISO-10303-21;`;
/** Only the message transport is controlled. Stations come from the real retained Rust/WASM evaluator. */
class AxisWorker implements AlignmentWorker {
  static instances: AxisWorker[] = [];
  onmessage: Worker['onmessage'] = null;
  onerror: Worker['onerror'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  axis?: AlignmentAxisJs;
  queued: AlignmentResponse[] = [];
  terminations = 0;
  frees = 0;
  constructor() { AxisWorker.instances.push(this); }
  postMessage(message: AlignmentRequest) {
    if (message.kind === 'dispose') {
      this.free(); if (this.onmessage) Reflect.apply(this.onmessage, null, [new MessageEvent('message', { data: { kind: 'disposed', id: message.id } })]); return;
    }
    if (message.kind === 'open') {
      const text = new TextDecoder().decode(sourceBytesFromTransferable(message.source).materialize());
      this.axis = new AxisConstructor(text, message.expressId);
    }
    assert.ok(this.axis);
    const sample = this.axis.evaluate(message.kind === 'evaluate' ? message.distance : 0);
    this.queued.push({ id: message.id, ok: true, metadata: { expressId: this.axis.expressId,
      GlobalId: this.axis.GlobalId, Name: this.axis.Name, approximate: this.axis.approximate,
      geometricHorizontalLengthMeters: this.axis.geometricHorizontalLengthMeters },
      sample: { geometricHorizontalDistanceMeters: sample[0], point: [sample[1], sample[2], sample[3]],
        tangent: [sample[4], sample[5], sample[6]] } });
  }
  flush() { for (const data of this.queued.splice(0)) if (this.onmessage) Reflect.apply(this.onmessage, null, [new MessageEvent('message', { data })]); }
  free() { if (this.axis) { this.axis.free(); this.axis = undefined; ++this.frees; } }
  terminate() { ++this.terminations; this.free(); }
}
const geometry: GeometryResult = { meshes: [], totalVertices: 0, totalTriangles: 0,
  coordinateInfo: { originShift: { x: 0, y: 0, z: 0 }, hasLargeCoordinates: false,
    originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1, z: 1 } },
    shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 1, z: 1 } } } };

test('real alignment binding survives unrelated updates, detaches on drag, reacquires and frees on owner removal (#6603)', async context => {
  const binary = new URL('../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
  if (!existsSync(binary)) { context.skip('WASM bundle missing; run pnpm build:wasm'); return; }
  const engine = await import('@ifc-lite/wasm');
  engine.initSync({ module: readFileSync(binary) }); AxisConstructor = engine.AlignmentAxisJs;
  const originalWorker = globalThis.Worker;
  globalThis.Worker = AxisWorker as unknown as typeof Worker;
  AxisWorker.instances = [];
  const ds = await new IfcParser().parseColumnar(new TextEncoder().encode(content).buffer, { disableWorkerScan: true });
  const owner = { ...fixtureModel('owner', { idOffset: 1_000_000 }), ifcDataStore: ds, geometryResult: geometry };
  const other = { ...fixtureModel('other', { idOffset: 2_000_000 }), geometryResult: geometry };
  const state = useViewerStore.getState();
  useViewerStore.setState({ ...fixtureModels(owner, other), sectionPlane: { ...state.sectionPlane,
    custom: undefined, enabled: false, flipped: true }, sectionPickMode: false });
  const stop = startAlignmentTool();
  try {
    chooseAlignmentMode();
    const pending = bindAlignment('owner', 20);
    const worker = AxisWorker.instances.at(-1); assert.ok(worker);
    useViewerStore.setState({ selectedEntityId: 17 });
    assert.equal(worker.terminations, 0, 'selection must not cancel initial parsing');
    worker.flush(); await pending;
    let cut = useViewerStore.getState().sectionPlane;
    assert.equal(cut.custom?.alignment?.modelId, 'owner'); assert.equal(cut.flipped, true);
    const stale = setAlignmentDistance(7), latest = setAlignmentDistance(8);
    worker.queued.reverse(); worker.flush(); await Promise.all([stale, latest]);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment?.geometricHorizontalDistanceMeters, 8);
    useViewerStore.setState({ models: new Map([['owner', owner]]) });
    const station = setAlignmentDistance(5); worker.flush(); await station;
    cut = useViewerStore.getState().sectionPlane;
    assert.ok(cut.custom);
    [5, 0.5, 0].forEach((expected, i) => assert.ok(Math.abs(cut.custom!.pickedAt[i] - expected) < 1e-12));
    assert.equal(cut.custom?.alignment?.geometricHorizontalDistanceMeters, 5);
    const view = new MutablePropertyView(ds.properties ?? null, 'owner');
    configureMutationView(view, ds); view.setAttribute(20, 'Name', 'Edited alignment', 'Road');
    state.toggleSectionPlane();
    assert.equal(useViewerStore.getState().sectionPlane.enabled, false);
    const pendingUi = render(<><ViewportHud /><SectionToolbar /></>);
    act(() => useViewerStore.setState({ mutationViews: new Map([['owner', view]]), mutationVersion: state.mutationVersion + 1 }));
    const edited = AxisWorker.instances.at(-1); assert.ok(edited);
    const distanceField = pendingUi.querySelector<HTMLElement>('[role="spinbutton"][aria-label="Horizontal distance from start"]');
    assert.ok(distanceField); assert.equal(distanceField.getAttribute('aria-disabled'), 'true');
    await setAlignmentDistance(6);
    press(distanceField, 'ArrowUp');
    assert.equal(edited.queued.length, 1, 'no station RPC can overtake the pending open');
    edited.flush();
    await new Promise<void>(resolve => setTimeout(resolve, 0)); edited.flush();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    assert.equal(useAlignmentToolState.getState().metadata?.Name, 'Edited alignment');
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment?.geometricHorizontalDistanceMeters, 6);
    assert.equal(useViewerStore.getState().sectionPlane.enabled, false, 'source edits preserve the Cut toggle');
    assert.equal(useAlignmentToolState.getState().error, undefined);
    assert.equal(distanceField.getAttribute('aria-disabled'), null);
    cleanup();
    assert.equal(worker.frees, 1);
    cut = useViewerStore.getState().sectionPlane;
    state.setSectionCustomDistance((cut.custom?.distance ?? 0) + 2);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
    assert.equal(edited.frees, 1); assert.equal(edited.terminations, 1);
    chooseAlignmentMode();
    const reacquire = bindAlignment('owner', 20);
    const next = AxisWorker.instances.at(-1); assert.ok(next); next.flush(); await reacquire;
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment?.expressId, 20);
    useViewerStore.setState({ models: new Map([['other', other]]) });
    assert.equal(useViewerStore.getState().sectionPlane.enabled, false);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
    assert.equal(next.frees, 1); assert.equal(next.terminations, 1);
    assert.match(useAlignmentToolState.getState().error ?? '', /removed/);
    useViewerStore.setState({ models: new Map([['owner', owner]]), mutationViews: new Map() });
    chooseAlignmentMode();
    const removedWhileOpening = bindAlignment('owner', 20);
    const opening = AxisWorker.instances.at(-1); assert.ok(opening);
    useViewerStore.setState({ models: new Map([['other', other]]) });
    opening.flush(); await removedWhileOpening;
    assert.equal(opening.frees, 1); assert.equal(opening.terminations, 1);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
    assert.equal(useViewerStore.getState().sectionPlane.enabled, false);
    useViewerStore.setState({ models: new Map([['owner', owner]]) });
    chooseAlignmentMode(); const finalBind = bindAlignment('owner', 20);
    const finalWorker = AxisWorker.instances.at(-1); assert.ok(finalWorker); finalWorker.flush(); await finalBind;
    const beforeClose = useViewerStore.getState().sectionPlane.custom; stop();
    assert.deepEqual(useViewerStore.getState().sectionPlane.custom?.pickedAt, beforeClose?.pickedAt);
    assert.equal(useViewerStore.getState().sectionPlane.custom?.alignment, undefined);
    assert.equal(finalWorker.frees, 1); assert.equal(finalWorker.terminations, 1);
  } finally { cleanup(); stop(); globalThis.Worker = originalWorker; useViewerStore.setState(state, true); }
});


test('mounted section toolbar enters alignment chooser and returns to ordinary cardinal cuts (#6603)', () => {
  const state = useViewerStore.getState();
  const model = { ...fixtureModel('model', { entities: [{ expressId: 20, type: 'IfcAlignment', name: 'Road' }] }), geometryResult: geometry };
  useViewerStore.setState({ ...fixtureModels(model), sectionPlane: { ...state.sectionPlane, custom: undefined, box: undefined }, sectionPickMode: false });
  try {
    const ui = render(<><ViewportHud /><SectionToolbar /></>);
    const segment = (name: string) => {
      const button = [...ui.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(candidate => candidate.textContent?.trim() === name);
      assert.ok(button); return button;
    };
    click(segment('Alignment'));
    assert.equal(segment('Alignment').getAttribute('aria-checked'), 'true');
    assert.ok(ui.querySelector('[aria-label="Alignment model"]'));
    assert.ok(ui.querySelector('[aria-label="Choose IfcAlignment"]'));
    click(segment('Down'));
    assert.equal(segment('Down').getAttribute('aria-checked'), 'true');
    assert.equal(ui.querySelector('[aria-label="Choose IfcAlignment"]'), null);
    assert.equal(useViewerStore.getState().sectionPlane.axis, 'down');
  } finally { cleanup(); act(() => useViewerStore.setState(state, true)); }
});


test('opening face-pick debounce cannot replace an explicitly chosen alignment mode (#6603)', async () => {
  const state = useViewerStore.getState();
  window.localStorage.clear();
  useViewerStore.setState({ activeTool: 'section', sectionPlane: { ...state.sectionPlane, custom: undefined, box: undefined }, sectionPickMode: false });
  try {
    const ui = render(<><ViewportHud /><SceneOverlayRoot><ToolOverlays /></SceneOverlayRoot></>);
    const segment = [...ui.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(candidate => candidate.textContent?.trim() === 'Alignment');
    assert.ok(segment); click(segment);
    await advance(250);
    assert.equal(useAlignmentToolState.getState().choosing, true);
    assert.equal(useViewerStore.getState().sectionPickMode, false);
    assert.equal(segment.getAttribute('aria-checked'), 'true');
  } finally { cleanup(); window.localStorage.clear(); act(() => useViewerStore.setState(state, true)); }
});
