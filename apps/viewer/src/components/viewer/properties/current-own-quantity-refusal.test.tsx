/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { StoreEditor } from '@ifc-lite/mutations';
import { extractQuantitiesOnDemand, extractTypeQuantitiesOnDemand } from '@ifc-lite/parser';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { useViewerStore } from '@/store';
import { PropertiesPanel } from '@/components/viewer/PropertiesPanel';
import { render, cleanup } from '@/test/render';
import { seedDeclaredZoneWall } from '@/test/zone-declared-fixture';
import { parse } from '@/test/inherited-quantities-native-fixture';
import { getOrCreateMutationView } from '@/sdk/adapters/mutation-view';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { getMaxExpressId } from '@/hooks/ingest/viewerModelIngest';
import { setGlobalRendererRef } from '@/hooks/useBCF';
import { buildZoneTable } from '@/hooks/useZoneTableExport';
import { QuantityType, PropertyValueType } from '@ifc-lite/data';
import { zonePropertySetName, zoneQuantitySetName } from '@/lib/zones';
import { applyZoneWriteBack, removeZoneWriteBack } from '@/hooks/useZoneWriteBack';
import { createQueryAdapter } from '@/sdk/adapters/query-adapter';
import { SelectionSummaryPanel } from './SelectionSummaryPanel';
import { entityRefToString } from '@/store/entity-ref';
import { zoneQuantitySources } from '@/lib/assistant/adapters/zone-volume-bases';

const initial = useViewerStore.getState();
afterEach(() => {
  cleanup(); setGlobalRendererRef({ current: null }); useViewerStore.setState(initial, true);
});

// #7379 / #7464: a bounded native read is unavailable, not verified absence.
for (const failure of ['sets', 'members', 'unreadable-members', 'unit-budget', 'unit-record'] as const) {
  for (const consumer of ['metadata', 'panel', 'zone-table', 'sdk', 'selection-summary', 'zone-evidence', 'write-back', 'remove-write-back'] as const) {
    test(`#7379 occurrence ${failure} refusal reaches ${consumer} without claiming absence`, async t => {
      const fixture = await seedDeclaredZoneWall(t); if (!fixture) return;
      const draft = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(draft);
      const editor = new StoreEditor(fixture.store, draft);
      const ownerId = fixture.store.getEntity(fixture.id)?.attributes[1];
      const owner = typeof ownerId === 'number' ? `#${ownerId}` : null;
      const unitIds: number[] = [];
      const members = Array.from({ length: failure === 'members' ? 4_097 : failure === 'unit-budget' ? 513 : 1 }, (_, index) => {
        if (failure === 'unit-budget' || failure === 'unit-record') {
          const unit = editor.addEntity('IfcSIUnit', ['*', '.LENGTHUNIT.', null, '.METRE.']).expressId;
          unitIds.push(unit);
          return editor.addEntity('IfcQuantityLength', [`BoundedCount${index}`, null, `#${unit}`, index + 1, null]).expressId;
        }
        return editor.addEntity('IfcQuantityCount', [`BoundedCount${index}`, null, null, index + 1, null]).expressId;
      });
      let qset = 0;
      for (let index = 0; index < (failure === 'sets' ? 257 : 1); index++) {
        qset = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner,
          `Bounded occurrence witness ${index}`, null, null, members.map(id => `#${id}`)]).expressId;
        editor.addEntity('IfcRelDefinesByProperties', [generateIfcGuid(), owner, null, null,
          [`#${fixture.id}`], `#${qset}`]);
      }
      // A real inherited default conflicts with the first unreadable own set.
      // Keep it in the exported IFC, but never promote it through unknown precedence.
      // @raw-entity-enumeration-ok fixture detaches its source type assignments before native export.
      for (const relation of fixture.store.entityIndex.byType.get('IFCRELDEFINESBYTYPE') ?? []) {
        const assigned = fixture.store.getEntity(relation)?.attributes[4];
        if (!Array.isArray(assigned) || !assigned.includes(fixture.id)) continue;
        const others = assigned.filter(id => id !== fixture.id);
        if (others.length) draft.setPositionalAttribute(relation, 4, others.map(id => `#${id}`));
        else draft.deleteEntity(relation);
      }
      const inheritedMember = editor.addEntity('IfcQuantityCount', ['BoundedCount0', null, null, 99, null]).expressId;
      const inheritedSet = editor.addEntity('IfcElementQuantity', [generateIfcGuid(), owner,
        'Bounded occurrence witness 0', null, null, [`#${inheritedMember}`]]).expressId;
      const inheritedType = editor.addEntity('IfcWallType', [generateIfcGuid(), owner, 'Refusal default type',
        null, null, [`#${inheritedSet}`], null, null, null, '.NOTDEFINED.']).expressId;
      editor.addEntity('IfcRelDefinesByType', [generateIfcGuid(), owner, null, null,
        [`#${fixture.id}`], `#${inheritedType}`]);
      const source = await parse(editedModelBytes(fixture.store, draft));
      const independent = extractQuantitiesOnDemand(source, fixture.id)
        .filter(set => set.name.startsWith('Bounded occurrence witness'));
      assert.equal(independent.length, failure === 'sets' ? 257 : 1,
        'independent export/reparse proves source sets exist before the bounded current read');
      assert.equal(independent[0].quantities.length, members.length);
      assert.equal(extractTypeQuantitiesOnDemand(source, fixture.id)?.quantities
        .flatMap(set => set.quantities).find(member => member.name === 'BoundedCount0')?.value, 99,
      'independent export/reparse proves conflicting inherited default exists');
      const model = useViewerStore.getState().models.get('arch'); assert.ok(model);
      useViewerStore.setState({ models: new Map([['arch', { ...model, ifcDataStore: source,
        maxExpressId: getMaxExpressId(source, model.geometryResult?.meshes ?? [], model.geometryResult?.pointClouds ?? []) }]]),
        ifcDataStore: source, mutationViews: new Map(), storeEditors: new Map(), propertiesActiveTab: 'quantities' });
      const current = getOrCreateMutationView(useViewerStore, 'arch'); assert.ok(current);
      if (failure === 'unreadable-members') current.setPositionalAttribute(qset, 5, "'unreadable'");
      if (failure === 'unit-record') current.setPositionalAttribute(unitIds[0], 0,
        Array.from({ length: 4_097 }, () => `#${unitIds[0]}`));
      if (failure === 'unit-budget') assert.equal(independent[0].quantities.filter(q => q.explicitUnitSiScale === 1).length, 513,
        'independent native source proves valid unit dependencies before the bounded current read');
      let revision = current.getMutationRevision();
      if (consumer === 'metadata') {
        assert.throws(() => current.getQuantitiesForEntity(fixture.id),
          (error: unknown) => error instanceof Error && error.name === 'OccurrenceQuantityReadError',
          'headless/native consumers must not receive an apparently complete empty result');
      } else if (consumer === 'sdk') {
        assert.throws(() => createQueryAdapter(useViewerStore).quantities({ modelId: 'arch', expressId: fixture.id }),
          (error: unknown) => error instanceof Error && error.name === 'OccurrenceQuantityReadError',
          'real SDK caller reports refusal rather than a complete empty inventory');
      } else if (consumer === 'selection-summary') {
        useViewerStore.setState({ selectedEntitiesSet: new Set([entityRefToString({ modelId: 'arch', expressId: fixture.id })]) });
        const ui = render(<SelectionSummaryPanel models={useViewerStore.getState().models} ifcDataStore={source} />);
        assert.match(ui.textContent ?? '', /Occurrence quantities are unavailable/,
          'mounted selection summary reports unknown quantity coverage without crashing or certifying absence');
      } else if (consumer === 'write-back' || consumer === 'remove-write-back') {
        // @raw-entity-enumeration-ok native fixture picks a second authored wall before testing an all-or-nothing preflight.
        const first = source.entityIndex.byType.get('IFCWALLSTANDARDCASE')?.find(id => id !== fixture.id);
        assert.ok(first);
        const assignment = useViewerStore.getState().zoneAssignments.get(fixture.id); assert.ok(assignment);
        useViewerStore.setState({ zoneAssignments: new Map([[first, assignment], [fixture.id, assignment]]),
          editEnabled: true, collabRoomId: null, canCollabEdit: () => true });
        if (consumer === 'remove-write-back') {
          current.createPropertySet(first, zonePropertySetName(fixture.zoneSet.name), [
            { name: 'ZoneSetId', value: fixture.zoneSet.id, type: PropertyValueType.Label }]);
          current.createQuantitySet(first, zoneQuantitySetName(fixture.zoneSet.name, 'net'), [
            { name: 'Left', value: 1, quantityType: QuantityType.Volume }]);
          revision = current.getMutationRevision();
        }
        assert.throws(() => consumer === 'write-back' ? applyZoneWriteBack(fixture.zoneSet, 'net') : removeZoneWriteBack(fixture.zoneSet),
          (error: unknown) => error instanceof Error && error.name === 'OccurrenceQuantityReadError',
          'real zone edit refuses the run before an earlier independently authored wall is modified');
        assert.equal(current.getMutationRevision(), revision,
          'a late unavailable quantity read leaves every native edit untouched');
      } else if (consumer === 'zone-evidence') {
        const evidence = zoneQuantitySources(useViewerStore.getState())({ modelId: 'arch', expressId: fixture.id });
        assert.equal(evidence.status, 'unavailable');
        assert.match(evidence.reason ?? '', /Native occurrence/);
        assert.deepEqual(evidence.quantities, [], 'explicit unavailable evidence does not promote conflicting inherited defaults');
        assert.equal(evidence.scale, null, 'unknown quantity inventory cannot produce a physical basis');
      } else if (consumer === 'zone-table') {
        const rows = buildZoneTable(fixture.zoneSet, 'net');
        const own = rows.filter(row => row.ExpressId === fixture.id);
        assert.equal(own.length, 2, 'the independently placed native wall remains in both touched zones');
        assert.ok(own.every(row => row.VolumeM3 === null && /current native quantities are unavailable/.test(row.Unavailable)),
          'each real exported table row reports unavailable instead of promoting inherited defaults or zero volume');
      } else {
        const ui = render(<PropertiesPanel />);
        assert.match(ui.textContent ?? '', /Occurrence quantities are unavailable/);
        assert.match(ui.textContent ?? '', failure === 'sets' ? /sets exceed the read limit/ : failure === 'unit-budget' ? /unit dependencies exceed the read limit/ : failure === 'unit-record' ? /unit references exceed the read limit/ : /members are unreadable or exceed the read limit/);
        assert.doesNotMatch(ui.textContent ?? '', /No quantities/, 'incomplete native coverage cannot be labelled verified absence');
        assert.match(ui.textContent ?? '', /Occurrence quantity precedence is unavailable/);
        assert.equal(ui.querySelector('section[aria-label="Inherited type quantities"]'), null,
          'unknown own overrides cannot promote independently existing inherited defaults');
      }
      assert.equal(current.getMutationRevision(), revision, 'refusal is a nonmutating read');
    });
  }
}
