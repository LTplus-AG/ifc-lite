/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup, type } from '@/test/render';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { parse } from '@/test/inherited-quantities-native-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { setGlobalRendererRef } from '@/hooks/useBCF';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true);
});

// Each consumer runs independently: stale wire metadata cannot hide a card failure.
for (const change of ['prefix', 'replacement', 'removal', 'unsupported', 'deleted', 'undo-redo', 'override'] as const) {
  for (const consumer of ['metadata', 'card'] as const) {
    test(`#7379 current native occurrence Unit ${change} reaches ${consumer}`, async t => {
      const f = await seedDeclaredZoneWall(t); if (!f) return;
      assert.equal(f.store.schemaVersion, 'IFC4');
      const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
      const editor = new StoreEditor(f.store, draft);
      // @raw-entity-enumeration-ok authentic fixture removes only its native occurrence quantity assignments before authoring the witness.
      for (const relation of f.store.entityIndex.byType.get('IFCRELDEFINESBYPROPERTIES') ?? []) {
        const attributes = f.store.getEntity(relation)?.attributes;
        if (!Array.isArray(attributes?.[4]) || !attributes[4].includes(f.id) || typeof attributes[5] !== 'number'
          || f.store.getEntity(attributes[5])?.type.toUpperCase() !== 'IFCELEMENTQUANTITY') continue;
        const others = attributes[4].filter(id => id !== f.id);
        if (others.length) draft.setPositionalAttribute(relation, 4, others.map(id => `#${id}`)); else draft.deleteEntity(relation);
      }
      const ownerId = f.store.getEntity(f.id)?.attributes[1];
      const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
      const metre = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', null, '.CUBIC_METRE.']).expressId;
      const centimetre = editor.addEntity('IfcSIUnit', ['*', '.VOLUMEUNIT.', '.CENTI.', '.CUBIC_METRE.']).expressId;
      const volume = editor.addEntity('IfcQuantityVolume', ['NetWitnessVolume', null, `#${metre}`, 10, null]).expressId;
      const count = editor.addEntity('IfcQuantityCount', ['UnitWitnessCount', null, null, 11, null]).expressId;
      const qto = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner, 'Current own unit witness', null, null, [`#${volume}`, `#${count}`]]).expressId;
      editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null, [`#${f.id}`], `#${qto}`]);
      const source = await parse(editedModelBytes(f.store, draft));
      const sourceQuantities = extractQuantitiesOnDemand(source, f.id).flatMap(set => set.quantities);
      const original = sourceQuantities.find(q => q.name === 'NetWitnessVolume'); assert.ok(original);
      assert.equal(original.value, 10); assert.equal(original.explicitUnit, 'm³'); assert.equal(original.explicitUnitSiScale, 1);
      assert.deepEqual(source.getEntity(qto)?.attributes[5], [volume, count]);
      const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
      useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
        maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? [], model.geometryResult?.pointClouds ?? []) }]]),
        ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map(), propertiesActiveTab: 'quantities', unitDisplayOverrides: {},
        editEnabled: true, collabRoomId: null, canCollabEdit: () => true, undoStacks: new Map(), redoStacks: new Map() });
      const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
      // @raw-entity-enumeration-ok authentic source Project is located before its current UnitsInContext edit.
      const project = source.entityIndex.byType.get('IFCPROJECT')?.[0]; assert.ok(project);
      current.setPositionalAttribute(project, 8, null);
      if (change === 'prefix' || change === 'override') current.setPositionalAttribute(metre, 2, '.CENTI.');
      else if (change === 'undo-redo') assert.ok(useViewerStore.getState().setPositionalAttribute('arch', metre, 2, '.CENTI.'),
        'the public edit-mode action accepts the native unit edit before testing its Undo/redo history');
      else if (change === 'unsupported') current.setPositionalAttribute(metre, 3, '.UNSUPPORTED.');
      else if (change === 'deleted') current.deleteEntity(metre);
      else current.setPositionalAttribute(volume, 2, change === 'replacement' ? `#${centimetre}` : null);
      const revision = current.getMutationRevision();
      const exported = await parse(editedModelBytes(source, current));
      assert.equal(exported.getEntity(project)?.attributes[8], null, 'native export confirms unknown current project unit context');
      const native = extractQuantitiesOnDemand(exported, f.id).flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'); assert.ok(native);
      assert.equal(native.value, 10);
      if (change === 'removal') {
        assert.equal(exported.getEntity(volume)?.attributes[2], null);
        assert.equal(native.explicitUnitSiScale, undefined, 'native Unit removal leaves an implicit quantity, not stale explicit metadata');
      } else if (change === 'unsupported' || change === 'deleted') {
        assert.equal(native.explicitUnitUnresolved, true, 'unreadable present Unit refuses a physical SI basis');
        assert.equal(native.explicitUnitSiScale, undefined);
      } else {
        assert.equal(native.explicitUnit, 'cm³');
        assert.ok(Math.abs((native.explicitUnitSiScale ?? 0) / (0.01 ** 3) - 1) <= Number.EPSILON * 4);
      }
      if (consumer === 'metadata') {
        const live = current.getQuantitiesForEntity(f.id).flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'); assert.ok(live);
        assert.deepEqual(live, native, 'shared live occurrence quantity metadata agrees with independently exported native IFC');
      } else {
        if (change === 'override') useViewerStore.setState({ unitDisplayOverrides: { VOLUMEUNIT: 'l' } });
        const ui = render(<PropertiesPanel />);
        const find = ui.querySelector<HTMLInputElement>('input[aria-label="Find properties"]'); assert.ok(find);
        type(find, 'Witness');
        assert.match(ui.textContent ?? '', /UnitWitnessCount\s*11/, 'dimensionless native values remain readable');
        if (change === 'removal' || change === 'unsupported' || change === 'deleted') {
          assert.match(ui.textContent ?? '', /NetWitnessVolume\s*10/, 'raw native magnitude remains readable without a known physical unit');
          assert.doesNotMatch(ui.textContent ?? '', /10\s*m³/, 'removed explicit Unit cannot be replaced with stale/default cubic metres');
        } else if (change === 'override') assert.match(ui.textContent ?? '', /NetWitnessVolume\s*0\.01\s*L/, 'display overrides convert current centimetre-cubed magnitude, without project context');
        else assert.match(ui.textContent ?? '', /NetWitnessVolume\s*10\s*cm³/, 'live native card uses current explicit unit despite unknown project context');
      }
      assert.equal(current.getMutationRevision(), revision, 'native extraction and public display are nonmutating reads');
      if (change === 'undo-redo') {
        cleanup();
        for (const step of ['undo', 'redo'] as const) {
          useViewerStore.getState()[step]('arch');
          const expected = step === 'undo' ? 'm³' : 'cm³';
          const saved = await parse(editedModelBytes(source, current));
          const reparsed: ReturnType<typeof extractQuantitiesOnDemand>[number]['quantities'][number] | undefined =
            extractQuantitiesOnDemand(saved, f.id).flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'); assert.ok(reparsed);
          assert.equal(reparsed.explicitUnit, expected);
          if (consumer === 'metadata') {
            assert.deepEqual(current.getQuantitiesForEntity(f.id).flatMap(set => set.quantities).find(q => q.name === 'NetWitnessVolume'), reparsed,
              'Undo/redo invalidates the native dependency memo despite retained edit history');
          } else {
            const ui = render(<PropertiesPanel />);
            const find = ui.querySelector<HTMLInputElement>('input[aria-label="Find properties"]'); assert.ok(find); type(find, 'Witness');
            assert.match(ui.textContent ?? '', new RegExp(`NetWitnessVolume\\s*10\\s*${expected}`));
            cleanup();
          }
        }
      }
    });
  }
}
