/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import type { Drawing2D, SectionPlaneConfig } from '@ifc-lite/drawing-2d';
import { render, click, advance, cleanup } from '@/test/render';
import { useViewerStore } from '@/store';
import { emptyPlacementState } from '@/lib/model-placement/state';
import { DxfUnderlayPanel } from './DxfUnderlayPanel';

const initial = useViewerStore.getState();
const side = { axis: 'x' as const, position: 5, flipped: false };
function generatedDrawing(): Drawing2D {
  return { config: { plane: side, projectionDepth: 10, includeHiddenLines: false, creaseAngle: 30, scale: 100 },
    lines: [{ line: { start: {x:0,y:0}, end: {x:10,y:5} }, category: 'cut', visibility: 'visible', entityId: 1, ifcType: 'IfcWall', modelIndex: 0, depth: 0 }],
    cutPolygons: [], projectionPolygons: [], bounds: {min:{x:0,y:0},max:{x:10,y:5}},
    stats: {cutLineCount:1,projectionLineCount:0,hiddenLineCount:0,silhouetteLineCount:0,polygonCount:0,totalTriangles:0,processingTimeMs:0} };
}
function reset() {
  useViewerStore.setState({ models: new Map(), activeModelId: null, geometryResult: null,
    modelPlacement: emptyPlacementState(), collabRoomId: null, dxfUnderlays: [], drawing2D: null });
}
afterEach(() => { cleanup(); useViewerStore.setState(initial, true); });
function button(ui: HTMLElement, name: string) {
  const result = [...ui.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.trim() === name || element.getAttribute('aria-label') === name);
  assert.ok(result, name); return result;
}

test('section DXF picker freezes its reference plane while real parsing awaits file bytes (#6615)', async () => {
  reset();
  const ui = render(<DxfUnderlayPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
  const input = ui.querySelector<HTMLInputElement>('input[accept=".dxf"]'); assert.ok(input);
  const text = '0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nElevation\n10\n0\n20\n0\n11\n2\n21\n3\n0\nENDSEC\n0\nEOF\n';
  let resolve!: (text: string) => void;
  const bytes = new Promise<string>(accept => { resolve = accept; });
  const file = new window.File([text], 'elevation.dxf', { type: 'application/dxf' });
  Object.defineProperty(file, 'text', { value: () => bytes });
  const transfer = new window.DataTransfer(); transfer.items.add(file);
  Object.defineProperty(input, 'files', { configurable: true, value: transfer.files });
  act(() => input.dispatchEvent(new window.Event('change', { bubbles: true })));
  act(() => useViewerStore.getState().setSectionPlanePosition(99));
  await act(async () => { resolve(text); await bytes; });
  for (let i=0;i<100 && !useViewerStore.getState().dxfUnderlays.length;i++) await advance(10);
  const underlay = useViewerStore.getState().dxfUnderlays[0];
  assert.ok(underlay);
  assert.deepEqual(underlay.referenceFrame?.originIfc, [5,0,0]);
  assert.equal(underlay.underlay.layers.flatMap(layer => layer.paths).length, 1, 'real line data reaches the shared DXF registry');
  assert.equal(button(ui, 'Center on model (no generated model extent)').disabled, true, 'compatibility alone supplies no model centre');
  act(() => useViewerStore.setState({ drawing2D: generatedDrawing() }));
  assert.equal(button(ui, 'Center on model').disabled, false, 'a compatible reference can be centered after model geometry is generated');
});

test('DXF placement defaults follow cardinal view changes until an explicit user choice (#6615)', () => {
  reset();
  function Harness() {
    const [plan, setPlan] = useState(true);
    return <>
      <button onClick={() => setPlan(false)}>Side view</button>
      <button onClick={() => setPlan(true)}>Down view</button>
      <DxfUnderlayPanel sectionPlane={plan ? {axis:'y',position:0,flipped:false} : side}
        planViewActive={plan} georeferenceAvailable={false} onCenterOnModel={() => {}} />
    </>;
  }
  const ui = render(<Harness />), selector = ui.querySelector<HTMLSelectElement>('select');
  assert.ok(selector);
  assert.equal(selector.value, 'site-plan');
  click(button(ui, 'Side view'));
  assert.equal(selector.value, 'plane-reference');
  act(() => { selector.value = 'site-plan'; selector.dispatchEvent(new window.Event('change', {bubbles:true})); });
  click(button(ui, 'Down view')); click(button(ui, 'Side view'));
  assert.equal(selector.value, 'site-plan', 'an explicit placement choice survives section changes');
});

async function pickDxf(ui: HTMLElement, text: string) {
  const input = ui.querySelector<HTMLInputElement>('input[accept=".dxf"]');
  assert.ok(input);
  const transfer = new window.DataTransfer();
  transfer.items.add(new window.File([text], 'unit-test.dxf', {type:'application/dxf'}));
  Object.defineProperty(input, 'files', {configurable:true,value:transfer.files});
  await act(async () => input.dispatchEvent(new window.Event('change', {bubbles:true})));
}

test('plane DXF imports request unknown units before registering and convert an explicit unit once (#6615)', async () => {
  for (const unitDeclaration of [0,999]) {
    reset(); cleanup();
    const text = ['0','SECTION','2','HEADER','9','$INSUNITS','70',String(unitDeclaration),'0','ENDSEC',
      '0','SECTION','2','ENTITIES','0','LINE','8','walls','10','0','20','0','11','3000','21','0',
      '0','ENDSEC','0','EOF'].join('\n');
    const ui = render(<DxfUnderlayPanel sectionPlane={side} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />);
    await pickDxf(ui,text);
    assert.equal(useViewerStore.getState().dxfUnderlays.length,0,'unitless/unknown units cannot silently commit a plane registration');
    const units = ui.querySelectorAll<HTMLSelectElement>('select')[1];
    act(() => { units.value = 'mm'; units.dispatchEvent(new window.Event('change', {bubbles:true})); });
    await pickDxf(ui,text);
    const entry = useViewerStore.getState().dxfUnderlays[0];
    assert.ok(entry?.referenceFrame);
    assert.equal(entry.underlay.unitScale,0.001);
    assert.deepEqual(entry.underlay.layers.flatMap(layer=>layer.paths)[0].points,[{x:0,y:0},{x:3,y:0}]);
    act(() => useViewerStore.getState().clearDxfUnderlays());
    const placement = ui.querySelector<HTMLSelectElement>('select'); assert.ok(placement);
    act(() => {
      placement.value='site-plan'; placement.dispatchEvent(new window.Event('change',{bubbles:true}));
      units.value='auto'; units.dispatchEvent(new window.Event('change',{bubbles:true}));
    });
    await pickDxf(ui,text);
    const site = useViewerStore.getState().dxfUnderlays[0];
    assert.ok(site && !site.referenceFrame,'legacy site plans retain their automatic import behavior');
    assert.equal(site.underlay.layers.flatMap(layer=>layer.paths)[0].points[1].x,3000);
  }
});


test('DXF picker reports a section changing to custom before file selection without getting stuck (#6615)', async () => {
  reset();
  function Harness() {
    const [plane, setPlane] = useState<SectionPlaneConfig>(side);
    return <>
      <button onClick={() => setPlane({...side,customPlane:{normal:{x:1,y:0,z:0},distance:5,
        origin:{x:5,y:0,z:0},tangent:{x:0,y:1,z:0},bitangent:{x:0,y:0,z:1}}})}>Custom view</button>
      <button onClick={() => setPlane(side)}>Restore side view</button>
      <DxfUnderlayPanel sectionPlane={plane} planViewActive={false} georeferenceAvailable={false} onCenterOnModel={() => {}} />
      <Toaster />
    </>;
  }
  const ui = render(<Harness />);
  const input = ui.querySelector<HTMLInputElement>('input[accept=".dxf"]'); assert.ok(input);
  let pickerOpened = 0;
  input.addEventListener('click', () => { pickerOpened++; });
  click(button(ui,'Import DXF...'));
  assert.equal(pickerOpened,1,'the normal import button opens the file picker');
  click(button(ui,'Custom view'));
  await pickDxf(ui,'0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n0\n20\n0\n11\n2\n21\n3\n0\nENDSEC\n0\nEOF');
  await advance(0);
  assert.equal(useViewerStore.getState().dxfUnderlays.length,0);
  assert.equal(input.value,'','selection is reset even when registration fails');
  assert.ok(ui.querySelector('[role="alert"]')?.textContent?.includes('Choose Down, Front or Side'));
  click(button(ui,'Restore side view'));
  assert.equal(button(ui,'Import DXF...').disabled,false,'importing state clears after failed registration');
  const dismiss = ui.querySelector<HTMLButtonElement>('[role="alert"] button');
  assert.ok(dismiss); click(dismiss);
});
