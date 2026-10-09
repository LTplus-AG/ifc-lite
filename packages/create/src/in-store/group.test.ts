/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IfcParser, effectiveMetadataRecord, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { RelationshipType } from '@ifc-lite/data';
import { IfcCreator } from '../ifc-creator.js';
import { AnchorEntityReader } from './resolve-anchor.js';
import { addGroupToStore, readGroupInStore, updateGroupInStore, removeGroupInStore } from './group.js';
import { GROUP_GRAPH_LIMITS } from './group-graph.js';

async function session(schema: 'IFC4' | 'IFC4X3' = 'IFC4') {
  let bytes: Uint8Array;
  if (schema === 'IFC4') {
    // Real Bonsai export, independently authored geometry and source roots.
    bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  } else {
    const creator = new IfcCreator({ Name: '#7329 IFC4X3 graph', Schema: schema, Timestamp: 0 });
    const level = creator.addIfcBuildingStorey({ Name: 'Level', Elevation: 0 });
    creator.addIfcWall(level, { Start: [0, 0, 0], End: [4, 0, 0], Thickness: .2, Height: 3 });
    bytes = new TextEncoder().encode(creator.toIfc().content);
  }
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  const mutationView = new MutablePropertyView(null, 'group-model');
  const editor = new StoreEditor(store, mutationView);
  const reader = new AnchorEntityReader(store, mutationView);
  const wall = reader.firstId('IFCWALL') ?? reader.firstId('IFCWALLSTANDARDCASE');
  if (wall === null) throw new Error('Real group fixture has no wall');
  const GlobalId = reader.entity(wall)?.attributes[0];
  if (typeof GlobalId !== 'string') throw new Error('Real wall identity unreadable');
  return { store, mutationView, ownerHistoryId: reader.firstId('IFCOWNERHISTORY'), editor, member: { expressId: wall, GlobalId } };
}

function state(s: Awaited<ReturnType<typeof session>>) {
  return JSON.stringify({ revision: s.mutationView.getMutationRevision(), mutations: s.mutationView.getMutations(),
    nextId: s.mutationView.peekNextExpressId(), created: s.mutationView.getNewEntities(), deleted: [...s.mutationView.getTombstones()] });
}

async function reread(s: Awaited<ReturnType<typeof session>>) {
  const content = new StepExporter(s.store, s.mutationView).export({ schema: s.store.schemaVersion as 'IFC4' | 'IFC4X3', applyMutations: true }).content;
  const store = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  return { store, mutationView: new MutablePropertyView(null, 'exported'), ownerHistoryId: null };
}

describe.each(['IFC4', 'IFC4X3'] as const)('generic group native lifecycle #7329 %s', schema => {
  it('exports complete replacement, stable group/relation identities, and empty membership without an empty SET', async () => {
    const s = await session(schema);
    const group = addGroupToStore(s, { Name: 'Work #999', RelatedObjects: [s.member] });
    const initial = readGroupInStore(s, group);
    expect(initial.memberships[0].RelatedObjects).toEqual([s.member]);
    const relationship = initial.memberships[0].relationship;
    updateGroupInStore(s, initial, { Name: 'Changed', Description: "Owner's group", RelatedObjects: [s.member] });
    const current = readGroupInStore(s, group);
    expect(current.Name).toBe('Changed');
    expect(current.memberships[0].relationship).toEqual(relationship);
    const saved = await reread(s);
    expect(readGroupInStore(saved, group)).toEqual(current);
    expect(saved.store.relationships.getRelated(group.expressId, RelationshipType.AssignsToGroup, 'forward')).toEqual([s.member.expressId]);
    expect(saved.store.getEntity(relationship.expressId)?.attributes[0]).toBe(relationship.GlobalId);
    updateGroupInStore(s, current, { RelatedObjects: [] });
    expect(readGroupInStore(await reread(s), group).memberships).toEqual([]);
    expect(s.mutationView.getTombstones().has(relationship.expressId)).toBe(true);
    removeGroupInStore(s, readGroupInStore(s, group));
    const exported = await reread(s);
    expect(exported.store.entityIndex.byId.has(group.expressId)).toBe(false);
    expect(exported.store.entityIndex.byId.has(s.member.expressId)).toBe(true);
  });

  it('removes only its membership from an incoming shared assignment and retains the other group and members', async () => {
    const s = await session(schema);
    const group = addGroupToStore(s, { Name: 'Child group', RelatedObjects: [s.member] });
    const parent = addGroupToStore(s, { Name: 'Parent group', RelatedObjects: [group, s.member] });
    const relation = readGroupInStore(s, parent).memberships[0].relationship;
    removeGroupInStore(s, readGroupInStore(s, group));
    const current = readGroupInStore(await reread(s), parent);
    expect(current.memberships).toEqual([{ relationship: relation, RelatedObjects: [s.member] }]);
  });

  it('refuses stale, deleted, duplicated or missing identities and preserves the complete transaction', async () => {
    const s = await session(schema);
    const group = addGroupToStore(s, { Name: 'Group', RelatedObjects: [s.member] });
    const initial = readGroupInStore(s, group);
    for (const RelatedObjects of [[s.member, s.member], [{ ...s.member, GlobalId: generateIfcGuid() }], [{ expressId: 999999, GlobalId: generateIfcGuid() }], [group]]) {
      const before = state(s);
      expect(() => updateGroupInStore(s, initial, { Name: 'Must not publish', RelatedObjects })).toThrow();
      expect(state(s)).toBe(before);
    }
    s.editor.setPositionalAttribute(group.expressId, 2, 'External change');
    const before = state(s);
    expect(() => removeGroupInStore(s, initial)).toThrow(/changed/);
    expect(state(s)).toBe(before);
    s.editor.addEntity('IfcGroup', [s.member.GlobalId, null, 'Duplicate root', null, null]);
    expect(() => readGroupInStore(s, group)).toThrow(/ambiguous/);
  });

  it('protects incoming dependencies on both the group and a removed relation without partial edits', async () => {
    const s = await session(schema);
    const group = addGroupToStore(s, { Name: 'Protected', RelatedObjects: [s.member] });
    const initial = readGroupInStore(s, group);
    const relationship = initial.memberships[0].relationship;
    s.editor.addEntity('IfcRelAssignsToGroup', [generateIfcGuid(), null, null, null, [`#${s.member.expressId}`], null, `#${relationship.expressId}`]);
    let before = state(s);
    expect(() => updateGroupInStore(s, initial, { RelatedObjects: [] })).toThrow(/protected incoming/);
    expect(state(s)).toBe(before);
    s.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${group.expressId}`, [`#${s.member.expressId}`]]);
    before = state(s);
    expect(() => removeGroupInStore(s, initial)).toThrow(/protected incoming/);
    expect(state(s)).toBe(before);
  });
});

it('bounds explicit file-controlled membership before publication #7329', async () => {
  const s = await session();
  const before = state(s);
  expect(() => addGroupToStore(s, { Name: 'Too many', RelatedObjects: Array.from({ length: GROUP_GRAPH_LIMITS.members + 1 }, () => s.member) })).toThrow(/budget/);
  expect(state(s)).toBe(before);
});

it('refuses a deleted source member and current named GlobalId changes #7329', async () => {
  const s = await session();
  s.editor.removeEntity(s.member.expressId);
  let before = state(s);
  expect(() => addGroupToStore(s, { Name: 'Deleted member', RelatedObjects: [s.member] })).toThrow(/live valid/);
  expect(state(s)).toBe(before);
  const empty = addGroupToStore(s, { Name: 'Current identity', RelatedObjects: [] });
  s.editor.setAttribute(empty.expressId, 'GlobalId', generateIfcGuid());
  before = state(s);
  expect(() => readGroupInStore(s, empty)).toThrow(/changed/);
  expect(state(s)).toBe(before);
});

it('does not confuse quoted STEP-looking metadata with an incoming dependency #7329', async () => {
  const s = await session();
  const group = addGroupToStore(s, { Name: 'Delete me', RelatedObjects: [s.member] });
  const other = addGroupToStore(s, { Name: `Quoted '#${group.expressId}' is text`, RelatedObjects: [] });
  removeGroupInStore(s, readGroupInStore(s, group));
  expect(readGroupInStore(await reread(s), other).Name).toBe(`Quoted '#${group.expressId}' is text`);
});

it('reports an oversized effective native record before publishing any group edit #7329', async () => {
  const s = await session();
  s.editor.addEntity('IfcGroup', [generateIfcGuid(), null, 'x'.repeat(GROUP_GRAPH_LIMITS.recordCharacters + 1), null, null]);
  const before = state(s);
  expect(() => addGroupToStore(s, { Name: 'Must not publish', RelatedObjects: [] })).toThrow(/record budget/);
  expect(state(s)).toBe(before);
});

it('a first refused operation preserves the fresh live allocator as well as its graph #7329', async () => {
  const { store } = await session();
  const mutationView = new MutablePropertyView(null, 'fresh');
  const held = mutationView.prepareAtomic(() => null), next = mutationView.peekNextExpressId();
  expect(() => addGroupToStore({ store, mutationView, ownerHistoryId: null }, { Name: '', RelatedObjects: [] })).toThrow(/Name/);
  expect(mutationView.peekNextExpressId()).toBe(next);
  held.validate();
  expect(mutationView.getNewEntities()).toEqual([]);
});

it('complete replacement safely consolidates multiple owned assignments and reuses the first Root identity #7329', async () => {
  const s = await session();
  const group = addGroupToStore(s, { Name: 'Multiple membership edges', RelatedObjects: [s.member] });
  const extra = s.editor.addEntity('IfcRelAssignsToGroup', [generateIfcGuid(), s.ownerHistoryId === null ? null : `#${s.ownerHistoryId}`, null, null, [`#${s.member.expressId}`], null, `#${group.expressId}`]).expressId;
  const before = readGroupInStore(s, group);
  expect(before.memberships).toHaveLength(2);
  updateGroupInStore(s, before, { RelatedObjects: [s.member] });
  const saved = await reread(s);
  expect(readGroupInStore(saved, group).memberships).toEqual([before.memberships[0]]);
  expect(saved.store.entityIndex.byId.has(extra)).toBe(false);
  expect(saved.store.relationships.getRelated(group.expressId, RelationshipType.AssignsToGroup, 'forward')).toEqual([s.member.expressId]);
});

it('refuses complete replacement of PRODUCT/PROCESS assignments without changing either exported semantic record #7329', async () => {
  const s = await session();
  const group = addGroupToStore(s, { Name: 'Typed memberships', RelatedObjects: [s.member] });
  const product = readGroupInStore(s, group).memberships[0].relationship.expressId;
  s.editor.setPositionalAttribute(product, 5, '.PRODUCT.');
  const taskGuid = generateIfcGuid();
  const taskId = s.editor.addEntity('IfcTask', [taskGuid, null, 'Task', null, null, null, null, null, '.NOTDEFINED.', null, null, null]).expressId;
  const task = { expressId: taskId, GlobalId: taskGuid };
  s.editor.addEntity('IfcRelAssignsToGroup', [generateIfcGuid(), null, null, null, [`#${taskId}`], '.PROCESS.', `#${group.expressId}`]);
  const expected = readGroupInStore(s, group);
  const before = await reread(s), transaction = state(s);
  for (const RelatedObjects of [[s.member, task], [], [task]]) {
    expect(() => updateGroupInStore(s, expected, { Name: 'Must not publish', RelatedObjects })).toThrow(/typed RelatedObjectsType/);
    expect(state(s)).toBe(transaction);
    const after = await reread(s);
    const graph = (source: typeof before) => {
      const reader = new AnchorEntityReader(source.store, source.mutationView);
      return [...source.store.entityIndex.byId.keys()].map(id => {
        const entity = reader.entity(id);
        if (!entity) throw new Error(`Independently exported graph record #${id} is unreadable`);
        return { id, type: entity.type, attributes: entity.attributes };
      });
    };
    expect(graph(after)).toEqual(graph(before));
  }
  expect(readGroupInStore(await reread(s), group)).toEqual(expected);
});

it('refuses consolidation of distinct untyped assignment metadata without publishing #7329', async () => {
  const s = await session();
  const group = addGroupToStore(s, { Name: 'Distinct edges', RelatedObjects: [s.member] });
  s.editor.addEntity('IfcRelAssignsToGroup', [generateIfcGuid(), null, 'Distinct assignment', 'Keep this description', [`#${s.member.expressId}`], null, `#${group.expressId}`]);
  const expected = readGroupInStore(s, group), before = state(s);
  expect(() => updateGroupInStore(s, expected, { RelatedObjects: [s.member] })).toThrow(/distinct assignment semantics/);
  expect(state(s)).toBe(before);
  expect(readGroupInStore(await reread(s), group)).toEqual(expected);
});

it('refuses changing even one typed assignment through an unpartitioned member list #7329', async () => {
  const s = await session();
  const group = addGroupToStore(s, { Name: 'Product-only group', RelatedObjects: [s.member] });
  const relation = readGroupInStore(s, group).memberships[0].relationship.expressId;
  s.editor.setPositionalAttribute(relation, 5, '.PRODUCT.');
  const expected = readGroupInStore(s, group), before = state(s);
  expect(() => updateGroupInStore(s, expected, { Name: 'Must not publish', RelatedObjects: [] })).toThrow(/typed RelatedObjectsType/);
  expect(state(s)).toBe(before);
  expect(readGroupInStore(await reread(s), group)).toEqual(expected);
});

it('bounds total effective record work and reports refusal rather than a truncated success #7329', async () => {
  const s = await session(), name = 'x'.repeat(2_000_000);
  // Native overlay records model exporter-controlled breadth; each record is below the per-record bound.
  for (let i = 0; i < 41; i++) s.editor.addEntity('IfcGroup', [generateIfcGuid(), null, name, null, null]);
  const next = s.mutationView.peekNextExpressId(), revision = s.mutationView.getMutationRevision();
  const count = s.mutationView.getNewEntities().length;
  expect(() => addGroupToStore(s, { Name: 'Must not publish a partial certification', RelatedObjects: [] })).toThrow(/total record work budget/);
  expect(s.mutationView.peekNextExpressId()).toBe(next);
  expect(s.mutationView.getMutationRevision()).toBe(revision);
  expect(s.mutationView.getNewEntities()).toHaveLength(count);
});

function danglingExportReferences(bytes: Uint8Array): number[] {
  const step = new TextDecoder().decode(bytes).replace(/'(?:[^']|'')*'|\/\*[\s\S]*?\*\//g, '');
  const defined = new Set([...step.matchAll(/^#(\d+)\s*=/gm)].map(match => Number(match[1])));
  return [...new Set([...step.matchAll(/#(\d+)/g)].map(match => Number(match[1])).filter(id => !defined.has(id)))].sort((a, b) => a - b);
}
const externalIfc4x3 = new URL('../../../../tests/models/ifc5/Railway_Railway_project_simple_IFC4X3.ifc', import.meta.url);
const hasExternalIfc4x3 = existsSync(externalIfc4x3);
if (!hasExternalIfc4x3) console.warn('skip: SierraSoft IFC4X3 group fixture missing — run `pnpm fixtures`');
it.skipIf(!hasExternalIfc4x3)('preserves the complete SierraSoft IFC4X3_ADD2 railway graph across native Group replacement and removal #7329', async () => {
  const bytes = readFileSync(externalIfc4x3);
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  expect(store.schemaVersion).toBe('IFC4X3');
  expect(store.getEntity(21)?.type).toBe('IFCRAILWAY');
  expect(store.getEntity(22)?.type).toBe('IFCALIGNMENT');
  const mutationView = new MutablePropertyView(store.properties || null, 'sierra');
  const context = { store, mutationView, ownerHistoryId: 2 };
  const roots = [21, 22].map(expressId => {
    const GlobalId = store.getEntity(expressId)?.attributes[0];
    if (typeof GlobalId !== 'string') throw new Error('SierraSoft fixture Root identity is unreadable');
    return { expressId, GlobalId };
  });
  const group = addGroupToStore(context, { Name: 'Reviewed railway population', RelatedObjects: roots });
  const created = readGroupInStore(context, group), relation = created.memberships[0].relationship;
  updateGroupInStore(context, created, { Name: 'Only the alignment', RelatedObjects: [roots[1]] });
  const content = new StepExporter(store, mutationView).export({ schema: 'IFC4X3', applyMutations: true }).content;
  const saved = await new IfcParser().parseColumnar(content.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  expect(danglingExportReferences(content)).toEqual([]);
  expect(saved.entities.getName(group.expressId)).toBe('Only the alignment');
  expect(saved.entities.getGlobalId(group.expressId)).toBe(group.GlobalId);
  expect(saved.getEntity(relation.expressId)?.attributes[0]).toBe(relation.GlobalId);
  expect(saved.relationships.getRelated(group.expressId, RelationshipType.AssignsToGroup, 'forward')).toEqual([22]);
  roots.forEach(root => expect(saved.getEntity(root.expressId)?.attributes[0]).toBe(root.GlobalId));
  removeGroupInStore(context, readGroupInStore(context, group));
  const removed = new StepExporter(store, mutationView).export({ schema: 'IFC4X3', applyMutations: true }).content;
  const restored = await new IfcParser().parseColumnar(removed.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
  expect(danglingExportReferences(removed)).toEqual([]);
  expect(restored.entityIndex.byId.has(group.expressId)).toBe(false);
  expect(restored.entityIndex.byId.has(relation.expressId)).toBe(false);
  // @raw-entity-enumeration-ok these independent imported/exported sources have no overlays; every original record and file reference must survive lifecycle removal.
  const records = (source: IfcDataStore) => [...source.entityIndex.byId.keys()].sort((a, b) => a - b)
    .map(expressId => ({ expressId, ...effectiveMetadataRecord(source, expressId) }));
  expect(records(restored)).toEqual(records(store));
});
