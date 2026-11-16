// SPDX-License-Identifier: MPL-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { StoreEditor, recordCompoundMutation, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { AnchorEntityReader } from '../resolve-anchor.js';
import { parse, session, THIRD_PARTY } from '../__test__/storey-fixtures.oracle.js';
import { readStoreyInventory, storeyContents } from './storey-model.js';
import { planStoreyLevelEdit } from './storey-level-plan.js';
import { storeyPlanningWork } from './storey-planning-diagnostics.js';
import { applyStoreyLevelEdit } from './storey-level-apply.js';
import { homeStoreyOf } from './storey-attachment.js';

afterEach(() => vi.restoreAllMocks());

it('#8452 a draft edited before its first inventory read cannot borrow the parent spatial graph', async () => {
  const s = session(await parse(THIRD_PARTY));
  readStoreyInventory(s.store, s.view);
  s.view.runAtomic(draft => {
    const product = draft.createEntity('IfcColumn', ['new', null, null, null, null, '#44', null, null, null]).expressId;
    draft.createEntity('IfcRelContainedInSpatialStructure', ['rel', null, null, null, [`#${product}`], '#42']);
    expect(homeStoreyOf(readStoreyInventory(s.store, draft), product)).toBe(42);
    expect(homeStoreyOf(readStoreyInventory(s.store, s.view), product)).toBeNull();
  });
});

it('#8452 a lazy relationship read materializes at first use even when a prior inventory warmed the graph', async () => {
  const s = session(await parse(THIRD_PARTY));
  readStoreyInventory(s.store, s.view);
  const lazy = readStoreyInventory(s.store, s.view, { lazyRelationships: true });
  const product = s.view.createEntity('IfcColumn', ['new', null, null, null, null, '#44', null, null, null]).expressId;
  s.view.createEntity('IfcRelContainedInSpatialStructure', ['rel', null, null, null, [`#${product}`], '#42']);
  expect(lazy.incoming.get(product)?.some(rel => rel.parent === 42)).toBe(true);
});

it('#8452 a parsed relationship arriving without an overlay edit invalidates the cached spatial inventory', async () => {
  const full = await parse(THIRD_PARTY);
  const original = session(full);
  const relation = readStoreyInventory(full, original.view).relationships.find(rel => rel.parent === 42 && rel.children.includes(60))!;
  const byId = new Map(full.entityIndex.byId);
  byId.delete(relation.id);
  const partial = { ...full, entityIndex: { ...full.entityIndex, byType: full.entityIndex.byType, byId } };
  const s = session(partial), revision = s.view.getMutationRevision();
  expect(storeyContents(readStoreyInventory(partial, s.view), 42).has(60)).toBe(false);
  byId.set(relation.id, full.entityIndex.byId.get(relation.id)!);
  expect(s.view.getMutationRevision()).toBe(revision);
  expect(storeyContents(readStoreyInventory(partial, s.view), 42).has(60)).toBe(true);
});

it('#8452 inherited products remain in moved IDs without repeated payload planning, including apply and undo', async () => {
  const s = session(await parse(THIRD_PARTY));
  const products = new Set<number>();
  for (let i = 0; i < 1000; i++) {
    const placement = s.view.createEntity('IfcLocalPlacement', ['#44', '#5']).expressId;
    const product = s.view.createEntity('IfcColumn', [`column-${i}`, null, null, null, null, `#${placement}`, null, null, null]).expressId;
    products.add(product);
    s.view.createEntity('IfcRelContainedInSpatialStructure', [`rel-${i}`, null, null, null, [`#${product}`], '#42']);
  }
  const edit = { kind: 'elevation' as const, storeyId: 42, Elevation: 3.5 };
  const cold = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), edit);
  expect(cold.refusals).toEqual([]);
  expect(cold.moved.filter(id => products.has(id))).toHaveLength(1000);
  const reads = new Set<number>();
  const read = AnchorEntityReader.prototype.entity;
  const spy = vi.spyOn(AnchorEntityReader.prototype, 'entity').mockImplementation(function(this: AnchorEntityReader, id) {
    if (products.has(id)) reads.add(id);
    return read.call(this, id);
  });
  const warm = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), edit);
  expect(warm).toEqual(cold);
  expect(storeyPlanningWork(cold)?.inventoryProducts).toBeGreaterThanOrEqual(1000);
  expect(storeyPlanningWork(warm)).toEqual({ inventoryProducts: 0, detailedProducts: 2 });
  expect(reads.size).toBeLessThan(10);
  spy.mockRestore();
  const before = s.text();
  recordCompoundMutation(s.view, draft => applyStoreyLevelEdit(s.store, new StoreEditor(s.store, draft), edit, warm));
  expect(s.worldZ([...products][0])).toBeCloseTo(3500);
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('Missing compound inverse'); });
  expect(s.text()).toBe(before);
});

it('#8452 changing a placement or escaped creation alias invalidates inheritance classification', async () => {
  const s = session(await parse(THIRD_PARTY));
  const placement = s.view.createEntity('IfcLocalPlacement', ['#44', '#5']).expressId;
  const row = s.view.createEntity('IfcColumn', ['column', null, null, null, null, `#${placement}`, null, null, null]);
  s.view.createEntity('IfcRelContainedInSpatialStructure', ['rel', null, null, null, [`#${row.expressId}`], '#42']);
  const edit = { kind: 'elevation' as const, storeyId: 42, Elevation: 3.5 };
  const plan = () => planStoreyLevelEdit(readStoreyInventory(s.store, s.view), edit, { dryRun: false });
  expect(plan().placements.some(p => p.leaf.placementId === placement)).toBe(false);
  s.view.setPositionalAttribute(placement, 0, '#31', true);
  expect(plan().placements.some(p => p.leaf.placementId === placement)).toBe(true);
  s.view.removePositionalMutation(placement, 0);
  expect(plan().placements.some(p => p.leaf.placementId === placement)).toBe(false);
  row.attributes[5] = '#61';
  expect(plan().placements.find(p => p.leaf.placementId === 61)?.owners).toContain(row.expressId);
});

it('#8452 retyping a cached local placement preserves the unreadable-placement refusal', async () => {
  const s = session(await parse(THIRD_PARTY));
  const placement = s.view.createEntity('IfcLocalPlacement', ['#44', '#5']).expressId;
  const product = s.view.createEntity('IfcColumn', ['column', null, null, null, null, `#${placement}`, null, null, null]).expressId;
  s.view.createEntity('IfcRelContainedInSpatialStructure', ['rel', null, null, null, [`#${product}`], '#42']);
  const edit = { kind: 'elevation' as const, storeyId: 42, Elevation: 3.5 };
  const plan = () => planStoreyLevelEdit(readStoreyInventory(s.store, s.view), edit, { dryRun: false });
  expect(plan().refusals).toEqual([]);
  s.view.setEntityType(placement, 'IfcDirection');
  expect(plan().refusals).toContainEqual(expect.objectContaining({ code: 'unreadablePlacement', elementIds: [product] }));
});
