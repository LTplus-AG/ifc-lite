/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { beforeEach, afterEach, it } from 'node:test';
import { createCollabDoc, createEntity, setPropertyValue, getPropertyValue } from '@ifc-lite/collab';
import { PropertyValueType } from '@ifc-lite/data';
import { seedModelingSession, MODEL_ID, STOREY, UPPER_STOREY } from '@/test/modeling-session-fixture';
import { useViewerStore } from '@/store';
import { act } from 'react';
import { selectPickedGlobalId } from '../viewport-selection';
import { render, cleanup, type, blur, click, press } from '@/test/render';
import { PropertyEditor } from '../PropertyEditor';
import { TooltipProvider } from '@/components/ui/tooltip';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { commitStoreyOp } from '@/store/slices/mutation-storey';
import { ModelInspectorPanel } from './ModelInspectorPanel';
import { WallTopRow, readWallTop } from './WallTopRow';
import { storeyAttachmentDisplay } from '@/lib/actions/storey-attachment-display';
let restoreRemesh = () => {};
beforeEach(async () => { await seedModelingSession(); restoreRemesh = setRequestRemesh(() => {}); useViewerStore.getState().enterModelWorkspace({ modelId: MODEL_ID, storeyId: STOREY }); });
afterEach(() => { cleanup(); useViewerStore.getState().exitModelWorkspace(); restoreRemesh(); });
it('#9296 shows the wall target name and elevation, with its GlobalId in details', () => {
  const s = useViewerStore.getState();
  const result = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in result);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, result.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={result.expressId} />);
  assert.match(ui.textContent ?? '', /To L1 \(\+3.00 m\)/);
  assert.equal(ui.querySelector('[title]')?.getAttribute('title'), guid);
  for (const value of [guid, ['IFCLABEL', guid], `IFCLABEL,${guid}`]) {
  const properties = render(<TooltipProvider><PropertyEditor modelId={MODEL_ID} entityId={result.expressId} psetName="IfcLite_StoreyAttachment" propName="TopConstraint" currentValue={value} /></TooltipProvider>);
  assert.match(properties.textContent ?? '', /To L1 \(\+3.00 m\)/);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, value)?.text, 'To L1 (+3.00 m)');
  if (typeof value === 'string') {
    s.setProperty(MODEL_ID, result.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', value, PropertyValueType.Label);
    const row = render(<WallTopRow modelId={MODEL_ID} wallId={result.expressId} />);
    assert.match(row.textContent ?? '', /To L1 \(\+3.00 m\)/);
  }
  }
  const display = storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'NextStoreyAbove');
  assert.equal(display?.text, `To L1 (+3.00 m)`);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'unknown-binding-kind'), null);
  assert.equal(storeyAttachmentDisplay(useViewerStore.getState(), MODEL_ID, result.expressId, 'missing-global-id'), null);
});

it('#9334 a known next-storey binding without an upper storey explains its fixed fallback', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, UPPER_STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', 'NextStoreyAbove', PropertyValueType.Label);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  assert.match(ui.textContent ?? '', /Next storey above \(none yet\) · 3.00 m fixed/);
  assert.equal(ui.textContent?.includes('NextStoreyAbove'), false);
});
it('#9334 a storey-derived height is read-only and names the level that drives it', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  s.setSelectedEntityId(wall.expressId);
  const ui = render(<ModelInspectorPanel />);
  assert.equal(ui.querySelector<HTMLInputElement>('[aria-label="Height in metres"]')?.readOnly, true);
  assert.match(ui.textContent ?? '', /from L1/);
});

it('#9334 an attached wall stays read-only when its resolved target storey has an empty name', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  s.setAttribute(MODEL_ID, UPPER_STOREY, 'Name', '');
  assert.equal(readWallTop(MODEL_ID, wall.expressId).target?.from, `#${UPPER_STOREY}`, 'the inventory supplies a nonempty name for the unnamed target');
  s.setSelectedEntityId(wall.expressId);
  const ui = render(<ModelInspectorPanel />);
  assert.equal(ui.querySelector<HTMLInputElement>('[aria-label="Height in metres"]')?.readOnly, true);
});

for (const typed of ['string', 'array'] as const) {
  it(`#9334 a typed IfcLabel ${typed} target selects attached mode and makes its derived height read-only`, () => {
    const s = useViewerStore.getState();
    const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
    assert.ok('expressId' in wall);
    const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
    const value = typed === 'array' ? ['IFCLABEL', guid] : `IFCLABEL,${guid}`;
    s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', value, PropertyValueType.Label);
    s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopBinding', 'Explicit', PropertyValueType.Label);
    s.setSelectedEntityId(wall.expressId);
    const ui = render(<ModelInspectorPanel />);
    assert.match(ui.textContent ?? '', /To L1 \(\+3.00 m\)/);
    assert.equal(ui.querySelector<HTMLInputElement>('input[type="radio"][value="storeyAbove"]')?.checked, true);
    assert.equal(ui.querySelector<HTMLInputElement>('[aria-label="Height in metres"]')?.readOnly, true);
    assert.match(ui.textContent ?? '', /from L1/);
  });
}

it('#9334 a relative top resolves the current next storey after insertion, not the recorded old GUID', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: 0.2 });
  assert.ok('expressId' in wall);
  const guid = s.models.get(MODEL_ID)!.ifcDataStore!.entities.getGlobalId(UPPER_STOREY)!;
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopConstraint', guid, PropertyValueType.Label);
  s.setProperty(MODEL_ID, wall.expressId, 'IfcLite_StoreyAttachment', 'TopBinding', 'Relative', PropertyValueType.Label);
  assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'add', params: { Name: 'Inserted', Elevation: 1.5, referenceStoreyId: STOREY } }).ok);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  assert.match(ui.textContent ?? '', /To Inserted \(\+1.50 m\)/);
  const properties = render(<TooltipProvider><PropertyEditor modelId={MODEL_ID} entityId={wall.expressId} psetName="IfcLite_StoreyAttachment" propName="TopConstraint" currentValue={guid} /></TooltipProvider>);
  assert.match(properties.textContent ?? '', /To Inserted \(\+1.50 m\)/);
});

// Round 5 W (#9296): exercise the controls and the shared viewport selection seam.
it('#9296 wall offset controls preserve a storey top and undo each edit once', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2 });
  assert.ok('expressId' in wall);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  assert.match(ui.textContent!, /To slab or roof…/);
  click(ui.querySelector('input[value="storeyAbove"]')!);
  const top = ui.querySelector<HTMLInputElement>('#wall-top-offset')!;
  type(top, '-0.2'); blur(top);
  assert.equal(top.value, '-0.200');
  assert.ok(Math.abs(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height - 2.8) < 1e-6);
  const base = ui.querySelector<HTMLInputElement>('#wall-base-offset')!;
  type(base, '0.4'); blur(base);
  let read = s.readWallEndpoints(MODEL_ID, wall.expressId)!;
  assert.ok(Math.abs(read.start[2] - .4) < 1e-6);
  assert.ok(Math.abs(read.height - 2.4) < 1e-6);
  act(() => s.undo(MODEL_ID));
  read = s.readWallEndpoints(MODEL_ID, wall.expressId)!;
  assert.ok(Math.abs(read.start[2]) < 1e-6);
  assert.ok(Math.abs(read.height - 2.8) < 1e-6);
  act(() => s.undo(MODEL_ID));
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height, 3);
});

it('#9296 viewport slab pick attaches, follows a move and undoes once without selecting the slab', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [1, 1, 0], End: [4, 1, 0], Height: 3, Thickness: .2 });
  const slab = s.addSlab(MODEL_ID, STOREY, { Position: [0, 0, 3.4], Width: 6, Depth: 6, Thickness: .3, ExtrudedDirection: [0, 0, -1], Name: 'Floor L2' });
  assert.ok('expressId' in wall && 'expressId' in slab);
  s.setSelectedEntityId(wall.expressId);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="element"]')!);
  act(() => selectPickedGlobalId(slab.expressId));
  assert.equal(useViewerStore.getState().selectedEntityId, wall.expressId);
  assert.match(ui.textContent!, /Slab 'Floor L2' underside/);
  assert.ok(Math.abs(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height - 3.1) < 1e-6);
  assert.equal(readWallTop(MODEL_ID, wall.expressId).top, 'element');
  act(() => s.translateEntity(MODEL_ID, slab.expressId, [0, 0, .2]));
  assert.ok(Math.abs(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height - 3.3) < 1e-6);
  act(() => s.undo(MODEL_ID));
  assert.ok(Math.abs(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height - 3.1) < 1e-6);
  act(() => s.undo(MODEL_ID));
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height, 3);
  assert.notEqual(readWallTop(MODEL_ID, wall.expressId).top, 'element');
});

it('#9296 invalid picks keep the wall selected; Escape cancels without an edit', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2 });
  assert.ok('expressId' in wall);
  s.setSelectedEntityId(wall.expressId);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="element"]')!);
  act(() => selectPickedGlobalId(wall.expressId));
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /Pick a slab or roof/);
  press(window, 'Escape');
  assert.equal(ui.querySelector('[role="status"]'), null);
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height, 3);
});

it('#9296 the edited top offset follows a later floor-to-floor change', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2 });
  assert.ok('expressId' in wall);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="storeyAbove"]')!);
  const top = ui.querySelector<HTMLInputElement>('#wall-top-offset')!;
  type(top, '-0.2'); blur(top);
  act(() => { assert.ok(commitStoreyOp(useViewerStore, MODEL_ID, { kind: 'level', edit: { kind: 'floorHeight', storeyId: STOREY, Height: 3.4 } }).ok); });
  assert.ok(Math.abs(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height - 3.2) < 1e-6);
  assert.equal(top.value, '-0.200');
});

it('#9296 roof pick uses the existing underside clip, and Fixed detaches it', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [1, 1, 0], End: [4, 1, 0], Height: 3, Thickness: .2 });
  const roof = s.addRoof(MODEL_ID, STOREY, { Position: [0, 0, 4], Width: 6, Depth: 6, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0], Name: 'Gable' });
  assert.ok('expressId' in wall && 'expressId' in roof);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="element"]')!);
  act(() => selectPickedGlobalId(roof.expressId));
  assert.match(ui.textContent!, /Roof 'Gable' underside/);
  assert.equal(readWallTop(MODEL_ID, wall.expressId).top, 'element');
  click(ui.querySelector('input[value="fixed"]')!);
  assert.equal(readWallTop(MODEL_ID, wall.expressId).top, 'fixed');
});

it('#9296 base offset on a fixed wall moves the wall without changing height and refuses inversion', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Height: 3, Thickness: .2 });
  assert.ok('expressId' in wall);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="storeyAbove"]')!);
  const base = ui.querySelector<HTMLInputElement>('#wall-base-offset')!;
  type(base, '5'); blur(base);
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /at least/);
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.start[2], 0);
  click(ui.querySelector('input[value="fixed"]')!);
  type(base, '0.5'); blur(base);
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height, 3);
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.start[2], .5);
});

it('#9296 roof coverage refusal appears inline and the existing target can be picked again', () => {
  const s = useViewerStore.getState();
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [1, 1, 0], End: [4, 1, 0], Height: 3, Thickness: .2 });
  const roof = s.addRoof(MODEL_ID, STOREY, { Position: [20, 20, 4], Width: 6, Depth: 6, Thickness: .25, EdgeSlopes: [Math.PI / 6, 0, Math.PI / 6, 0] });
  const slab = s.addSlab(MODEL_ID, STOREY, { Position: [0, 0, 3.4], Width: 6, Depth: 6, Thickness: .3, ExtrudedDirection: [0, 0, -1] });
  assert.ok('expressId' in wall && 'expressId' in roof && 'expressId' in slab);
  const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
  click(ui.querySelector('input[value="element"]')!);
  act(() => selectPickedGlobalId(roof.expressId));
  assert.match(ui.querySelector('[role="alert"]')!.textContent!, /does not cover/);
  assert.equal(s.readWallEndpoints(MODEL_ID, wall.expressId)!.height, 3);
  act(() => selectPickedGlobalId(slab.expressId));
  const repick = [...ui.querySelectorAll('button')].find(button => button.textContent === 'Pick another slab or roof…');
  assert.ok(repick);
  click(repick);
  assert.ok(ui.querySelector('[role="status"]'));
  press(window, 'Escape');
  assert.equal(readWallTop(MODEL_ID, wall.expressId).top, 'element');
});


it('#9296 picked attachment publishes its constraint to the collaboration property channel', () => {
  const s = useViewerStore.getState(), doc = createCollabDoc();
  createEntity(doc, '/Wall', { ifcClass: 'IfcWall' });
  const wall = s.addWall(MODEL_ID, STOREY, { Start: [1, 1, 0], End: [4, 1, 0], Height: 3, Thickness: .2 });
  const slab = s.addSlab(MODEL_ID, STOREY, { Position: [0, 0, 3.4], Width: 6, Depth: 6, Thickness: .3, ExtrudedDirection: [0, 0, -1] });
  assert.ok('expressId' in wall && 'expressId' in slab);
  const mirror = s.mirrorPropertyEdit;
  useViewerStore.setState({ mirrorPropertyEdit: (_model, id, pset, name, value) => {
    assert.equal(id, wall.expressId);
    assert.equal(typeof value, 'string');
    setPropertyValue(doc, '/Wall', pset, name, { type: 'IfcLabel', value: String(value) });
  } });
  try {
    const ui = render(<WallTopRow modelId={MODEL_ID} wallId={wall.expressId} />);
    click(ui.querySelector('input[value="element"]')!);
    act(() => selectPickedGlobalId(slab.expressId));
    assert.equal(getPropertyValue(doc, '/Wall', 'IfcLite_StoreyAttachment', 'TopConstraint')?.value,
      useViewerStore.getState().mutationViews.get(MODEL_ID)!.getNewEntity(slab.expressId)!.attributes[0]);
    assert.equal(getPropertyValue(doc, '/Wall', 'IfcLite_StoreyAttachment', 'TopBinding')?.value, 'Explicit');
  } finally { useViewerStore.setState({ mirrorPropertyEdit: mirror }); doc.destroy(); }
});
