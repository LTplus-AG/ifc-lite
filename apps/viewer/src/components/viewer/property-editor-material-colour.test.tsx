import '@/test/setup-dom.js';
import { beforeEach, afterEach, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRelatedLists } from '@ifc-lite/create';
import { extractAllMaterialsOnDemand } from '@ifc-lite/parser';
import { StepExporter, serializeEntitySubgraph } from '@ifc-lite/export';
import { useViewerStore } from '@/store';
import { MODEL_ID, STOREY, seedModelingSession } from '@/test/modeling-session-fixture';
import { cleanup, click, render, type } from '@/test/render';
import { setRequestRemesh } from '@/lib/commands/modeling/transaction';
import { AddMaterialDialog } from './property-editor-classification-material-dialogs';
import { LayersSection } from './model-inspector/LayersSection';
import { applyMaterialLayers, setElementMaterial } from './model-inspector/inspector-edits';

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
const exported = () => new StepExporter(store(), view()).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set() }).content;

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
  s().undo(MODEL_ID);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Concrete']);
});

it('layer creation carries its colour into the remesh subgraph (#9296 M)', () => {
  // Exercise the New material control, not a synthetic styled-item fixture.
  const live = { dataStore: store(), view: view() };
  const ui = render(<LayersSection modelId={MODEL_ID} live={live} kind="wall" initial={[]} elementId={wall} typeId={null} defaultThickness={0.2} />);
  const set = applyMaterialLayers(MODEL_ID, { kind: 'wall', target: 'element', elementId: wall, typeId: null, layers: [{ thickness: .2, material: { name: 'Brick', color: '#b5523b' } }] });
  assert.notEqual(set, null);
  const sub = serializeEntitySubgraph(store(), view(), { targets: new Set([wall]) });
  assert.match(new TextDecoder().decode(sub.bytes), /IFCMATERIALDEFINITIONREPRESENTATION/);
  assert.match(String(exported()), /0\.709803/);
  assert.ok(ui.querySelector('[data-inspector-apply-layers]'));
});

it('reassignment keeps other recipients, exports one material, and undo restores it (#9296 M)', () => {
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Concrete', Color: '#808080' }), true);
  assert.equal(setElementMaterial(MODEL_ID, wall, { Name: 'Steel', Color: '#404080' }), true);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Steel']);
  assert.equal(readRelatedLists(store(), 'IfcRelAssociatesMaterial', view()).filter(r => r.relatedIds.includes(wall)).length, 1);
  const sub = serializeEntitySubgraph(store(), view(), { targets: new Set([wall]) });
  assert.match(new TextDecoder().decode(sub.bytes), /IFCMATERIALDEFINITIONREPRESENTATION/);
  s().undo(MODEL_ID);
  assert.deepEqual(extractAllMaterialsOnDemand(store(), wall, view()).map(m => m.name), ['Concrete']);
});
