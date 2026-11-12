/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRelatedLists } from '@ifc-lite/create';
import { IfcParser, extractAllMaterialsOnDemand } from '@ifc-lite/parser';
import { StepExporter, serializeEntitySubgraph } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, press, render, type } from '@/test/render';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { AddMaterialDialog } from './property-editor-classification-material-dialogs';
import { LayersSection } from './model-inspector/LayersSection';
import { applyMaterialLayers } from './model-inspector/inspector-edits';

import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { addMaterialAssociation } from '@/lib/authoring/associations';

const setElementMaterial = (modelId: string, id: number, input: { Name: string; Color: string }) => addMaterialAssociation(modelId, id, { name: input.Name, color: input.Color }).ok;

const s = () => useViewerStore.getState();
let wall: number;
let restore: () => void;
beforeEach(async () => {
  await seedModelingSession();
  restore = setRequestRemesh(() => {});
  const result = s().addWall(MODEL_ID, STOREY, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 });
  assert.ok('expressId' in result);
  wall = result.expressId;
});
afterEach(() => { cleanup(); restore(); });
const input = (label: string) => {
  const found = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  assert.ok(found, label);
  return found;
};
const store = () => s().models.get(MODEL_ID)!.ifcDataStore!;
const view = () => s().mutationViews.get(MODEL_ID)!;
const exported = () => {
  const { content } = new StepExporter(store(), view()).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set() });
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
};

it('Properties creates Brick with a material appearance and replaces its old material (#9296 M)', () => {
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Concrete', Color: '#808080' }), true);
  const ui = render(<AddMaterialDialog modelId={MODEL_ID} entityId={wall} entityType="IfcWall" />);
  click(ui.querySelector('button')!);
  assert.ok(document.querySelector('input[type="color"]'), 'colour swatch');
  type(document.querySelector<HTMLInputElement>('input[placeholder="e.g., Concrete C30/37"]')!, 'Brick');
  type(input('Material colour hex'), '#b5523b');
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Add Material')!);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Brick']);
  assert.equal(readRelatedLists(store(), 'IfcRelAssociatesMaterial', view()).filter(r => r.relatedIds.includes(wall)).length, 1);
  assert.match(String(exported()), /IFCMATERIALDEFINITIONREPRESENTATION/);
  assert.match(String(exported()), /0\.709803/);
  click(ui.querySelector('button')!);
  assert.equal(input('Material colour hex').value, '#808080', 'saving resets the next material colour');
  click([...document.querySelectorAll('button')].find(b => b.textContent === 'Cancel')!);
  s().undo(MODEL_ID);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Concrete']);
});

it('layer creation carries its colour into the remesh subgraph (#9296 M)', async () => {
  // The layer constructor uses the same colour-bearing create method.
  const live = { dataStore: store(), view: view() };
  const ui = render(<LayersSection modelId={MODEL_ID} live={live} kind="wall" initial={[]} elementId={wall} typeId={null} defaultThickness={0.2} />);
  const set = applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'element', elementId: wall, typeId: null, layers: [{ thickness: .2, material: { name: 'Brick', color: '#b5523b' } }] });
  assert.notEqual(set, null);
  const sub = serializeEntitySubgraph(store(), view(), { targets: new Set([wall]) });
  assert.match(new TextDecoder().decode(sub.bytes), /IFCMATERIALDEFINITIONREPRESENTATION/);
  const mini = await new IfcParser().parseColumnar(sub.bytes.slice().buffer as ArrayBuffer);
  const colours = mini.getEntitiesByType('IFCCOLOURRGB');
  assert.equal(colours.length, 1, 'the assigned Brick appearance is in the mini STEP');
  const rgb = colours[0].attributes.slice(1, 4);
  assert.ok(rgb.every((v, i) => typeof v === 'number' && Math.abs(v - [181, 82, 59][i] / 255) < 1e-6), `mini STEP RGB: ${rgb}`);
  assert.ok(ui.querySelector('[data-inspector-apply-layers]'));
});

it('reassignment exports one material, and undo restores it (#9296 M)', () => {
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Concrete', Color: '#808080' }), true);
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Steel', Color: '#404080' }), true);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Steel']);
  assert.equal(readRelatedLists(store(), 'IfcRelAssociatesMaterial', view()).filter(r => r.relatedIds.includes(wall)).length, 1);
  const sub = serializeEntitySubgraph(store(), view(), { targets: new Set([wall]) });
  assert.match(new TextDecoder().decode(sub.bytes), /IFCMATERIALDEFINITIONREPRESENTATION/);
  s().undo(MODEL_ID);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Concrete']);
});


it('the slab material picker replaces the association through a real selection (#9296 M)', async () => {
  const module = await import('./model-inspector/MaterialSection').catch(() => null);
  assert.ok(module?.MaterialSection, 'single-material inspector picker exists');
  const added = s().addSlab(MODEL_ID, STOREY, { Position: [0, 0, 0], Width: 4, Depth: 3, Thickness: .2 });
  assert.ok('expressId' in added);
  assert.equal(setElementMaterial(MODEL_ID, added.expressId, { Name: 'Concrete', Color: '#808080' }), true);
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Steel', Color: '#404080' }), true);
  const ui = render(<module.MaterialSection modelId={MODEL_ID} elementId={added.expressId} live={{ dataStore: store(), view: view() }} />);
  const trigger = ui.querySelector('[role="combobox"]'); assert.ok(trigger);
  press(trigger, 'ArrowDown');
  const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === 'Steel');
  assert.ok(option, 'model materials listed');
  assert.ok(option.querySelector('[style]'), 'material swatch');
  press(option, 'Enter');
  assert.deepEqual(extractAllMaterialsOnDemand(store(), added.expressId, view()).map(m => m.name), ['Steel']);
  assert.equal(readRelatedLists(store(), 'IfcRelAssociatesMaterial', view()).filter(r => r.relatedIds.includes(added.expressId)).length, 1);
});


it('imported material swatches find a surface style after a curve style (#9296 M)', async () => {
  const reader = await import('@/lib/authoring/material-colour').catch(() => null);
  assert.ok(reader?.materialColour, 'material swatch reader exists');
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Brick', Color: '#b5523b' }), true);
  const material = [...view().getNewEntitiesOfType('IFCMATERIAL')].find(e => e.attributes[0] === 'Brick');
  const styled = [...view().getNewEntitiesOfType('IFCSTYLEDITEM')].find(e => e.attributes[0] === null);
  assert.ok(material && styled);
  const styles = styled.attributes[1]; assert.ok(Array.isArray(styles));
  const surface = styles[0]; assert.ok(typeof surface === 'string');
  recordModellingEdit(useViewerStore, MODEL_ID, (_methods, draft) => {
    const blue = draft.addEntity('IfcColourRgb', [null, { real: 0 }, { real: 0 }, { real: 1 }]);
    const curve = draft.addEntity('IfcCurveStyle', ['Outline', null, null, `#${blue.expressId}`, null]);
    const assignment = draft.addEntity('IfcPresentationStyleAssignment', [[`#${curve.expressId}`, surface]]);
    draft.setPositionalAttribute(styled.expressId, 1, [`#${assignment.expressId}`]);
  });
  const imported = await new IfcParser().parseColumnar(new TextEncoder().encode(exported()).buffer as ArrayBuffer);
  assert.equal(reader.materialColour({ dataStore: imported, view: null }, material.expressId), '#b5523b');
});
