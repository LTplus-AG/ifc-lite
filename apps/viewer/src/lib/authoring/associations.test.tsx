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
import { readFileSync } from 'node:fs';
import { IfcParser, extractAllMaterialsOnDemand, extractClassificationsOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from '@ifc-lite/export';
import { useViewerStore } from '@/store/index.js';
import { resolveEntityRef } from '@/store/resolveEntityRef.js';
import { pathForEntity, pathForGuid, registerEntityPath, registerStoreSlot } from '@/lib/collab/entity-paths.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { cleanup, click, render, type as typeInput } from '@/test/render.js';
import { AddMaterialDialog } from '@/components/viewer/PropertyEditor.js';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel.js';

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
#12=IFCWALL('0Wall00000000000000012',$,'Wall C',$,$,$,$,$,$);
#20=IFCMATERIAL('Concrete',$,$);
#21=IFCRELASSOCIATESMATERIAL('0Rel000000000000000021',$,$,$,(#11),#20);
#30=IFCCLASSIFICATION($,$,$,'OmniClass',$,$,$);`);

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

  it('reuses source definitions and reparses new associations in an authored SketchUp IFC4 model', async () => {
    // A tracked IFC-manager for SketchUp 2024 export. Its #34 classification,
    // #62 material and #61 material relationship are independent source data,
    // not the synthetic STEP rows used by the focused schema tests below.
    const authored = readFileSync(new URL('../../../public/samples/building-architecture.ifc', import.meta.url), 'utf8');
    store = await seed(authored);
    assert.equal(extractAllMaterialsOnDemand(store, 30).length, 0, 'the building has no source material');
    assert.deepEqual(extractAllMaterialsOnDemand(store, 52).map((value) => value.name),
      ['concrete_reinforced_in-situ'], 'the source slab is associated with the material before editing');
    assert.deepEqual(api().addClassificationAssociation('m', 262, {
      system: 'CCI Construction', identification: 'E-AAA-WALL', name: 'Outer wall',
    }), { ok: true });
    assert.deepEqual(api().addMaterialAssociation('m', 30, { name: 'concrete_reinforced_in-situ' }), { ok: true });
    assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATION')].length, 0, 'source classification reused');
    assert.equal([...view().getNewEntitiesOfType('IFCMATERIAL')].length, 0, 'source material reused');
    assert.equal([...view().getNewEntitiesOfType('IFCRELASSOCIATESMATERIAL')].length, 0, 'source relationship extended');
    assert.deepEqual(view().getPositionalMutationsForEntity(61)?.get(4), ['#52', '#30']);

    const { reparsed } = await exportAndReparse(store, 'IFC4');
    assert.deepEqual(reparsed.getEntity(61)?.attributes.slice(4, 6), [[52, 30], 62],
      'the exported source relationship still names its original slab and material');
    assert.deepEqual(extractClassificationsOnDemand(reparsed, 262)
      .map((value) => [value.system, value.identification, value.name]),
    [['CCI Construction', 'E-AAA-WALL', 'Outer wall']]);
    assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 30).map((value) => value.name),
      ['concrete_reinforced_in-situ']);
    assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 52).map((value) => value.name),
      ['concrete_reinforced_in-situ'], 'the original slab keeps the shared material');
  });

  it('the Add Material dialog writes IfcMaterial + IfcRelAssociatesMaterial, not a property set', async () => {
    store = await seed(IFC4);
    const container = render(<AddMaterialDialog modelId="m" entityId={10} entityType="IfcWall" />);
    click([...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Add material')!);
    const input = [...document.body.querySelectorAll('input')].find((i) => i.placeholder === 'e.g., Concrete C30/37') as HTMLInputElement;
    typeInput(input, 'Steel');
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
      const relationships = reparsed.getEntitiesByType('IFCRELASSOCIATESCLASSIFICATION');
      assert.equal(relationships.length, 1);
      assert.equal(relationships[0].attributes[1], null, 'IFC4 relationship has optional OwnerHistory');
      assert.deepEqual(relationships[0].attributes[4], [10]);
      const referenceId = relationships[0].attributes[5];
      assert.ok(typeof referenceId === 'number');
      assert.equal(reparsed.getEntity(referenceId)?.type, 'IFCCLASSIFICATIONREFERENCE');
      assert.doesNotMatch(text, /Classification \[/, 'no look-alike property set');
      const read = extractClassificationsOnDemand(reparsed, 10);
      assert.equal(read.length, 1);
      assert.equal(read[0].system, 'Uniclass');
      assert.equal(read[0].identification, 'Ss_25');
      assert.equal(read[0].name, 'Walls');
      // …and the Properties panel sees it before any export.
      assert.deepEqual(api().overlayClassifications(view(), [10], 'IFC4').map((c) => [c.system, c.identification, c.name]), [['Uniclass', 'Ss_25', 'Walls']]);
    });

    it('one undo removes every entity the add created; redo brings them back', () => {
      api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' });
      assert.equal(view().getNewEntities().length, 3);
      useViewerStore.getState().undo('m');
      assert.equal(view().getNewEntities().filter((e) => !view().isDeleted(e.expressId)).length, 0);
      assert.deepEqual(api().overlayClassifications(view(), [10], 'IFC4'), []);
      useViewerStore.getState().redo('m');
      assert.equal(api().overlayClassifications(view(), [10], 'IFC4').length, 1);
    });

    it('a second code in the same system reuses its IfcClassification', () => {
      api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' });
      api().addClassificationAssociation('m', 11, { system: 'Uniclass', identification: 'Ss_30' });
      assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATION')].length, 1);
      assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATIONREFERENCE')].length, 2);
    });

    it('reuses a source IfcClassification by Name and the panel resolves its system', async () => {
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'OmniClass', identification: '23-11' }), { ok: true });
      assert.equal([...view().getNewEntitiesOfType('IFCCLASSIFICATION')].length, 0);
      const { reparsed } = await exportAndReparse(store, 'IFC4');
      assert.deepEqual(extractClassificationsOnDemand(reparsed, 10).map((c) => [c.system, c.identification]), [['OmniClass', '23-11']]);
      assert.deepEqual(api().overlayClassifications(view(), [10], 'IFC4', store).map((c) => c.system), ['OmniClass']);
    });

    it('a material exports as IfcMaterial + IfcRelAssociatesMaterial and reads back with its category', async () => {
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Steel', category: 'Metal' }), { ok: true });
      const { text, reparsed } = await exportAndReparse(store, 'IFC4');
      assert.doesNotMatch(text, /Material \[/, 'no look-alike property set');
      const read = extractAllMaterialsOnDemand(reparsed, 10);
      assert.deepEqual(read.map((m) => [m.type, m.name, m.category]), [['Material', 'Steel', 'Metal']]);
      assert.deepEqual(api().overlayMaterials(view(), [10], 'IFC4').map((m) => m.name), ['Steel']);
    });

    it('a same-named material reuses its entity and association, preserving its original fields', async () => {
      api().addMaterialAssociation('m', 10, { name: 'Steel', category: 'Metal' });
      api().addMaterialAssociation('m', 12, { name: 'Steel', category: 'Wood' });
      assert.equal([...view().getNewEntitiesOfType('IFCMATERIAL')].length, 1);
      assert.equal([...view().getNewEntitiesOfType('IFCRELASSOCIATESMATERIAL')].length, 1);
      assert.deepEqual(api().overlayMaterials(view(), [12], 'IFC4').map((m) => m.category), ['Metal']);
      const { reparsed } = await exportAndReparse(store, 'IFC4');
      assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 12).map((m) => m.category), ['Metal']);
    });

    it('extends a source material association and one undo restores its original RelatedObjects', async () => {
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Concrete' }), { ok: true });
      assert.equal(view().getNewEntities().length, 0, 'source material and relationship are reused');
      assert.deepEqual(view().getPositionalMutationsForEntity(21)?.get(4), ['#11', '#10']);
      assert.deepEqual(api().overlayMaterials(view(), [10], 'IFC4', store).map((m) => m.name), ['Concrete']);
      const { reparsed } = await exportAndReparse(store, 'IFC4');
      assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 10).map((m) => m.name), ['Concrete']);
      useViewerStore.getState().undo('m');
      assert.equal(view().getPositionalMutationsForEntity(21), null, 'one undo removes the extension');
      const undone = await exportAndReparse(store, 'IFC4');
      assert.deepEqual(extractAllMaterialsOnDemand(undone.reparsed, 10), []);
      assert.deepEqual(extractAllMaterialsOnDemand(undone.reparsed, 11).map((m) => m.name), ['Concrete']);
    });

    it('the mounted Properties panel shows source-reused classification and material associations', () => {
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'OmniClass', identification: '23-11' }), { ok: true });
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Concrete' }), { ok: true });
      useViewerStore.setState({
        selectedEntity: { modelId: 'm', expressId: 10 }, selectedEntityId: 10,
        selectedModelId: null, selectedEntities: [], selectedEntityIds: new Set([10]),
      });
      const panel = render(<PropertiesPanel />);
      assert.match(panel.textContent ?? '', /OmniClass/);
      assert.match(panel.textContent ?? '', /23-11/);
      assert.match(panel.textContent ?? '', /Concrete/);
      cleanup();
    });

    it('mirrors authored relationships and source material extensions only for the shared model', () => {
      registerStoreSlot(store, { slotId: 'm0', pathPrefix: '/m0' });
      const original = useViewerStore.getState();
      const creates: Array<{ id: number; type: string }> = [];
      const attributes: Array<{ id: number; name: string; value: unknown }> = [];
      useViewerStore.setState({
        collabRoomId: 'room',
        collabRoomModels: new Map([['m', { slotId: 'm0', pathPrefix: '/m0' }]]),
        mirrorEntityCreate: (_modelId, id, type, roomKey) => {
          creates.push({ id, type });
          if (roomKey) registerEntityPath(store, id, pathForGuid(store, roomKey));
        },
        mirrorAttributeEdit: (_modelId, id, name, value) => {
          attributes.push({ id, name, value });
        },
      });
      try {
        assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'OmniClass', identification: '23-11' }), { ok: true });
        assert.ok(creates.some((call) => call.type.toUpperCase() === 'IFCCLASSIFICATIONREFERENCE'));
        assert.ok(creates.some((call) => call.type.toUpperCase() === 'IFCRELASSOCIATESCLASSIFICATION'));
        const wallPath = pathForEntity(store, 10);
        assert.ok(wallPath);
        const hasWallRoomPath = (value: unknown) => Array.isArray(value) && value.some((item) =>
          item !== null && typeof item === 'object' && !Array.isArray(item)
          && 'ifc-lite::entityPath' in item && item['ifc-lite::entityPath'] === wallPath);
        assert.ok(attributes.some((call) => call.name === 'bsi::ifc::prop::RelatedObjects'
          && hasWallRoomPath(call.value)), 'relationship references are room paths, not sender-local ids');
        const beforeExtension = creates.length;
        assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Concrete' }), { ok: true });
        assert.equal(creates.length, beforeExtension, 'extending source IfcRelAssociatesMaterial creates no duplicate entity');
        assert.ok(attributes.some((call) => call.id === 21 && call.name === 'bsi::ifc::prop::RelatedObjects'
          && hasWallRoomPath(call.value)), 'the source relationship extension is mirrored');
      } finally {
        useViewerStore.setState({
          collabRoomId: original.collabRoomId,
          collabRoomModels: original.collabRoomModels,
          mirrorEntityCreate: original.mirrorEntityCreate,
          mirrorAttributeEdit: original.mirrorAttributeEdit,
        });
      }
    });

    it('an element sees the session associations of the base it aliases', () => {
      api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25' });
      api().addMaterialAssociation('m', 10, { name: 'Steel' });
      // A duplicate (say #99) resolving to base #10 reads [99, 10], as the panel passes it.
      assert.equal(api().overlayClassifications(view(), [99, 10], 'IFC4').length, 1);
      assert.equal(api().overlayMaterials(view(), [99, 10], 'IFC4').length, 1);
    });

    it('refuses a conflicting material association on an element that already has one', () => {
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

  it('keeps source reuse and authored association IDs in the selected model of a federation', async () => {
    const first = await parse(IFC4);
    const second = await parse(IFC4);
    const a = { ...fixtureModel('a', { idOffset: 0 }), ifcDataStore: first, maxExpressId: 30 };
    const b = { ...fixtureModel('b', { idOffset: 1_000_000 }), ifcDataStore: second, maxExpressId: 30 };
    useViewerStore.setState({
      ...fixtureModels(a, b), activeModelId: 'b', mutationViews: new Map(), storeEditors: new Map(),
      undoStacks: new Map(), redoStacks: new Map(), mutationBatchTags: new Map(), dirtyModels: new Set(), collabRole: null,
    });
    assert.deepEqual(api().addClassificationAssociation('b', 10, { system: 'OmniClass', identification: '23-11' }), { ok: true });
    assert.deepEqual(api().addMaterialAssociation('b', 10, { name: 'Concrete' }), { ok: true });
    const created = [...useViewerStore.getState().mutationViews.get('b')!.getNewEntitiesOfType('IFCCLASSIFICATIONREFERENCE')][0];
    assert.deepEqual(resolveEntityRef(1_000_000 + created.expressId), { modelId: 'b', expressId: created.expressId });
    assert.equal(useViewerStore.getState().mutationViews.get('a'), undefined, 'the other model has no overlay');
    const result = new StepExporter(second, useViewerStore.getState().mutationViews.get('b')!).export({ schema: 'IFC4', visibleOnly: false, hiddenEntityIds: new Set<number>() });
    const exported = typeof result.content === 'string' ? result.content : new TextDecoder().decode(result.content);
    const reparsed = await parse(exported);
    assert.deepEqual(extractClassificationsOnDemand(reparsed, 10).map((c) => c.system), ['OmniClass']);
    assert.deepEqual(extractAllMaterialsOnDemand(reparsed, 10).map((m) => m.name), ['Concrete']);
    assert.deepEqual(extractClassificationsOnDemand(first, 10), [], 'the first model remains unchanged');
    assert.deepEqual(extractAllMaterialsOnDemand(first, 10), [], 'the first model remains unchanged');
  });

  describe('IFC2X3', () => {
    it('writes the IFC2X3 layouts with the model\'s OwnerHistory and reads back', async () => {
      store = await seed(IFC2X3(true));
      assert.deepEqual(api().addClassificationAssociation('m', 10, { system: 'Uniclass', identification: 'Ss_25', name: 'Walls' }), { ok: true });
      assert.deepEqual(api().addMaterialAssociation('m', 10, { name: 'Brick' }), { ok: true });
      const { reparsed } = await exportAndReparse(store, 'IFC2X3');
      const classification = reparsed.getEntitiesByType('IFCCLASSIFICATION');
      assert.equal(classification.length, 1);
      assert.deepEqual(classification[0].attributes, ['Uniclass', '', null, 'Uniclass']);
      const relationships = reparsed.getEntitiesByType('IFCRELASSOCIATESCLASSIFICATION');
      assert.equal(relationships.length, 1);
      assert.equal(relationships[0].attributes[1], 5, 'IFC2X3 relationship keeps the model OwnerHistory');
      assert.deepEqual(reparsed.getEntitiesByType('IFCMATERIAL').map((material) => material.attributes[0]), ['Brick']);
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
