/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #5876: "Add Classification" / "Add Material" wrote look-alike property sets
 * ("Classification [Uniclass]") that no reader or downstream tool recognises.
 * They must create real IFC entities: exported, read back by the parser's own
 * classification / material readers, shown by the panel's overlay readers,
 * undone as one step, and schema-correct for IFC2X3 and IFC4.
 *
 * Real viewer store over real parsed models; the export is re-parsed and read
 * through `extractClassificationsOnDemand` / `extractAllMaterialsOnDemand`.
 */

import '@/test/setup-dom.js';
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IfcParser, extractAllMaterialsOnDemand, extractClassificationsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, click, render } from '@/test/render.js';
import { AddMaterialDialog } from '@/components/viewer/PropertyEditor.js';

// Guarded: both modules are new in #5876. With the fix reverted they are
// absent, and the tests must fail on an assertion, not on a load error.
const writer: Partial<typeof import('./associations.js')> = await import('./associations.js').catch(() => ({}));
const reader: Partial<typeof import('./association-overlay.js')> = await import('./association-overlay.js').catch(() => ({}));
function api() {
  const { addClassificationAssociation, addMaterialAssociation } = writer;
  const { overlayClassifications, overlayMaterials } = reader;
  assert.ok(addClassificationAssociation && addMaterialAssociation && overlayClassifications && overlayMaterials,
    'lib/authoring exports the association writer and overlay readers (#5876)');
  return { addClassificationAssociation, addMaterialAssociation, overlayClassifications, overlayMaterials };
}

const step = (schema: string, data: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('a.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`;

const IFC4 = step('IFC4', `#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',$,'Wall A',$,$,$,$,$,$);
#11=IFCWALL('0Wall00000000000000011',$,'Wall B',$,$,$,$,$,$);
#20=IFCMATERIAL('Concrete',$,$);
#21=IFCRELASSOCIATESMATERIAL('0Rel000000000000000021',$,$,$,(#11),#20);`);

const IFC2X3 = (withOwnerHistory: boolean) => step('IFC2X3', `${withOwnerHistory ? '#5=IFCOWNERHISTORY($,$,$,.ADDED.,$,$,$,0);\n' : ''}#1=IFCPROJECT('0Project0000000000000a',${withOwnerHistory ? '#5' : '$'},'P',$,$,$,$,$,$);
#10=IFCWALL('0Wall00000000000000010',${withOwnerHistory ? '#5' : '$'},'Wall A',$,$,$,$,$);`);

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

async function seed(text: string): Promise<IfcDataStore> {
  const store = await parse(text);
  useViewerStore.setState({
    ...fixtureModels({ ...fixtureModel('m'), ifcDataStore: store }),
    mutationViews: new Map(),
    storeEditors: new Map(),
    undoStacks: new Map(),
    redoStacks: new Map(),
    mutationBatchTags: new Map(),
    dirtyModels: new Set(),
    collabRole: null,
  });
  return store;
}

const view = () => useViewerStore.getState().mutationViews.get('m')!;

async function exportAndReparse(store: IfcDataStore, schema: 'IFC4' | 'IFC2X3'): Promise<{ text: string; reparsed: IfcDataStore }> {
  const out = new StepExporter(store, view()).export({ schema, visibleOnly: false, hiddenEntityIds: new Set<number>() });
  const text = typeof out.content === 'string' ? out.content : new TextDecoder().decode(out.content);
  return { text, reparsed: await parse(text) };
}

describe('Add Classification / Add Material create real IFC entities (#5876)', () => {
  let store: IfcDataStore;

  it('the Add Material dialog writes IfcMaterial + IfcRelAssociatesMaterial, not a property set', async () => {
    store = await seed(IFC4);
    const container = render(<AddMaterialDialog modelId="m" entityId={10} entityType="IfcWall" />);
    click([...container.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'Add material')!);
    const input = [...document.body.querySelectorAll('input')].find((i) => i.placeholder === 'e.g., Concrete C30/37') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, 'Steel');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    click([...document.body.querySelectorAll('button')].find((b) => b.textContent === 'Add Material')!);
    const { text, reparsed } = await exportAndReparse(store, 'IFC4');
    cleanup();
    assert.doesNotMatch(text, /Material \[Steel\]/, 'no look-alike property set');
    assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 10).map((m) => m.name), ['Steel']);
  });

  describe('IFC4', () => {
    beforeEach(async () => { store = await seed(IFC4); });

    it('a classification exports as IfcClassificationReference + IfcRelAssociatesClassification and reads back', async () => {
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25', name: 'Walls' }), { ok: true });
      const { text, reparsed } = await exportAndReparse(store, 'IFC4');
      assert.match(text, /IFCRELASSOCIATESCLASSIFICATION\('[^']{22}',\$,\$,\$,\(#10\),#\d+\)/);
      assert.doesNotMatch(text, /Classification \[/, 'no look-alike property set');
      const read = extractClassificationsOnDemand(reparsed, 10);
      assert.equal(read.length, 1);
      assert.equal(read[0].system, 'Uniclass');
      assert.equal(read[0].identification, 'Ss_25');
      assert.equal(read[0].name, 'Walls');
      // …and the Properties panel sees it before any export.
      assert.deepEqual(api().overlayClassifications(view(), 10, 'IFC4').map((c) => [c.system, c.identification, c.name]), [['Uniclass', 'Ss_25', 'Walls']]);
    });

    it('one undo removes every entity the add created; redo brings them back', () => {
      api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' });
      assert.equal(view().getNewEntities().length, 3);
      useViewerStore.getState().undo('m');
      assert.equal(view().getNewEntities().filter((e) => !view().isDeleted(e.expressId)).length, 0);
      assert.deepEqual(api().overlayClassifications(view(), 10, 'IFC4'), []);
      useViewerStore.getState().redo('m');
      assert.equal(api().overlayClassifications(view(), 10, 'IFC4').length, 1);
    });

    it('a second code in the same system reuses its IfcClassification', () => {
      api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' });
      api().addClassificationAssociation('m', 11, { system: 'Uniclass', identification: 'Ss_30' });
      assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATION')].length, 1);
      assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATIONREFERENCE')].length, 2);
    });

    it('a material exports as IfcMaterial + IfcRelAssociatesMaterial and reads back with its category', async () => {
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Steel', category: 'Metal' }), { ok: true });
      const { text, reparsed } = await exportAndReparse(store, 'IFC4');
      assert.doesNotMatch(text, /Material \[/, 'no look-alike property set');
      const read = extractAllMaterialsOnDemand(reparsed, 10);
      assert.deepEqual(read.map((m) => [m.type, m.name, m.category]), [['Material', 'Steel', 'Metal']]);
      assert.deepEqual(api().overlayMaterials(view(), 10, 'IFC4').map((m) => m.name), ['Steel']);
    });

    it('refuses a second material association on an element that already has one', () => {
      assert.deepEqual(api().addMaterialAssociation('m', 11, { name: 'Steel' }), { ok: false, reasonKey: 'propertyEditor.association.hasMaterial' });
      api().addMaterialAssociation('m', 10, { name: 'Steel' });
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Wood' }), { ok: false, reasonKey: 'propertyEditor.association.hasMaterial' });
    });

    it('refuses text the STEP writer would read as a token', () => {
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: '#12' }), { ok: false, reasonKey: 'propertyEditor.association.stepToken' });
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: '.STEEL.' }), { ok: false, reasonKey: 'propertyEditor.association.stepToken' });
      assert.equal(view()?.getNewEntities().length ?? 0, 0);
    });
  });

  describe('IFC2X3', () => {
    it('writes the IFC2X3 layouts with the model\'s OwnerHistory and reads back', async () => {
      store = await seed(IFC2X3(true));
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25', name: 'Walls' }), { ok: true });
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Brick' }), { ok: true });
      const { text, reparsed } = await exportAndReparse(store, 'IFC2X3');
      assert.match(text, /IFCCLASSIFICATION\('Uniclass','',\$,'Uniclass'\)/);
      assert.match(text, /IFCRELASSOCIATESCLASSIFICATION\('[^']{22}',#5,/);
      assert.match(text, /IFCMATERIAL\('Brick'\)/);
      assert.equal(extractClassificationsOnDemand(reparsed, 10)[0]?.identification, 'Ss_25');
      assert.equal(extractAllMaterialsOnDemand(reparsed, 10)[0]?.name, 'Brick');
    });

    it('refuses when the model has no IfcOwnerHistory, which IFC2X3 requires on the rel', async () => {
      await seed(IFC2X3(false));
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' }), { ok: false, reasonKey: 'propertyEditor.association.noOwnerHistory' });
      assert.equal(view().getNewEntities().length, 0);
    });
  });
});
