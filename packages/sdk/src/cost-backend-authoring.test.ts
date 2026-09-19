/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #4857 PR A — loaded-model cost authoring: `bim.store.addCost*` /
 * `nestCostItems` / `assignCostItemsToSchedule` / `assignToCostItem` /
 * `setCostItemValues` / `removeCostEntity`, built on `createCostStoreBackend`.
 *
 * The oracle is the same one `cost-backend-mutations.test.ts` uses: author
 * through the overlay, read it back with `bim.cost.data()` (PR A's
 * `CostMutationOverlay.created()`, so this is also the round-trip test for
 * that plumbing), export with `StepExporter`, re-parse, and the graph read
 * from the exported bytes must equal the pending read.
 *
 * `existsSync`/`skipIf` mirrors `headless-backend-cost.test.ts`: the canonical
 * manifest fixture is fetched by `pnpm fixtures` and may be absent on a host
 * that has not run it — the inline STEP fixture above covers the same
 * contract either way.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { createCostBackend } from './cost-backend.js';
// Through the package barrel, not `./cost-store-backend.js` directly — see
// `packages/create/src/in-store/cost.test.ts`'s import comment for why: a
// direct import of a brand-new file dies at load on revert (dead import,
// not a RED); routed through `./index.js` (existing file, diff-only-adds),
// a revert instead fails every call below as "is not a function".
import { createCostStoreBackend, type CostStoreModelResolution } from './index.js';
import type { CostGraphData } from './cost-types.js';

const STEP_LINES = [
  "ISO-10303-21;",
  "HEADER;",
  "FILE_DESCRIPTION((''),'2;1');",
  "FILE_NAME('cost.ifc','2026-01-01T00:00:00',(''),(''),'','','');",
  "FILE_SCHEMA(('IFC4'));",
  "ENDSEC;",
  "DATA;",
  "#1=IFCWALL('0wall00000000000000001',$,'Exterior wall',$,$,$,$,$,$);",
  "#40=IFCCOSTSCHEDULE('0sched0000000000000001',$,'Tender schedule',$,$,'CS-1',.TENDER.,'Issued',$,$);",
  "#41=IFCCOSTITEM('0item00000000000000001',$,'Facade package',$,$,'A',.NOTDEFINED.,$,$);",
  "ENDSEC;",
  "END-ISO-10303-21;",
];

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

/** A loaded model with a real overlay, its `bim.cost` backend, and its `bim.store` cost authoring methods. */
async function session() {
  const store = await parse(STEP_LINES.join('\n'));
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  const cost = createCostBackend(() => ({ modelId: 'm', store, mutationView: view }));
  const resolution: CostStoreModelResolution = { modelId: 'm', store, editor, ownerHistoryId: null };
  const storeCost = createCostStoreBackend(() => resolution, cost);
  const exportedGraph = async (): Promise<CostGraphData> => {
    const exported = new StepExporter(store, view).export({ schema: store.schemaVersion, applyMutations: true });
    const reparsed = await parse(new TextDecoder().decode(exported.content));
    return createCostBackend(() => ({ modelId: 'm', store: reparsed })).data();
  };
  return { store, view, cost, storeCost, exportedGraph };
}

describe('bim.store cost authoring round-trips through bim.cost and StepExporter (#4857)', () => {
  it('a newly authored IfcCostValue + IfcCostItem is visible to bim.cost before export, and survives export/reparse', async () => {
    const { storeCost, cost, exportedGraph } = await session();
    const value = storeCost.addCostValue('m', { Name: 'Rate', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 42 } });
    const item = storeCost.addCostItem('m', { Name: 'New item', CostValues: [value.expressId] });

    const pending = cost.data('m');
    const pendingItem = pending.CostItems.find(i => i.ref.expressId === item.expressId);
    expect(pendingItem?.Name).toBe('New item');
    expect(pendingItem?.CostValues?.map(r => r.expressId)).toEqual([value.expressId]);
    const pendingValue = pending.CostValues.find(v => v.ref.expressId === value.expressId);
    expect(pendingValue?.AppliedValue).toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '42.' });

    const exported = await exportedGraph();
    const exportedItem = exported.CostItems.find(i => i.Name === 'New item');
    expect(exportedItem).toBeDefined();
    const exportedValue = exported.CostValues.find(v => v.ref.expressId === exportedItem!.CostValues?.[0]?.expressId);
    expect(exportedValue?.AppliedValue).toEqual({ Kind: 'Typed', Type: 'IFCMONETARYMEASURE', Value: '42.' });
  });

  it('nests a new child under the existing schedule item, then reparents it to a new parent', async () => {
    const { storeCost, cost } = await session();
    const child = storeCost.addCostItem('m', { Name: 'Child' }).expressId;
    storeCost.nestCostItems('m', 41, [child]);
    expect(cost.data('m').Relationships.some(
      r => r.Type === 'IfcRelNests' && r.RelatingObject?.expressId === 41 && r.RelatedObjects?.some(o => o.expressId === child),
    )).toBe(true);

    const newParent = storeCost.addCostItem('m', { Name: 'Other parent' }).expressId;
    storeCost.nestCostItems('m', newParent, [child]);
    const graph = cost.data('m');
    expect(graph.Relationships.some(
      r => r.Type === 'IfcRelNests' && r.RelatingObject?.expressId === 41 && r.RelatedObjects?.some(o => o.expressId === child),
    )).toBe(false);
    expect(graph.Relationships.some(
      r => r.Type === 'IfcRelNests' && r.RelatingObject?.expressId === newParent && r.RelatedObjects?.some(o => o.expressId === child),
    )).toBe(true);
  });

  it('refuses an ancestor/descendant nesting cycle, not just direct self-nesting', async () => {
    const { storeCost } = await session();
    const parent = storeCost.addCostItem('m', { Name: 'Parent' }).expressId;
    const child = storeCost.addCostItem('m', { Name: 'Child' }).expressId;
    storeCost.nestCostItems('m', parent, [child]);
    // Trying to nest `parent` under its own existing child would create a
    // parent<->child cycle without a direct parentId === childId.
    expect(() => storeCost.nestCostItems('m', child, [parent]))
      .toThrow(new RegExp(`parentId #${child} is already a descendant of childId #${parent}`));
  });

  it('does not copy a SECOND existing IfcRelAssignsToControl\'s members into the primary one when appending', async () => {
    const { storeCost, cost, view } = await session();
    const item = storeCost.addCostItem('m', { Name: 'I' }).expressId;
    const primaryRel = storeCost.assignCostItemsToSchedule('m', 40, [item]).expressId;
    // A second, separate IfcRelAssignsToControl for the SAME schedule,
    // legally controlling a different item.
    const other = storeCost.addCostItem('m', { Name: 'Other' }).expressId;
    const secondRel = view.createEntity('IfcRelAssignsToControl', [
      '0ctrl00000000000000003', null, null, null, [`#${other}`], null, '#40',
    ]).expressId;

    const newItem = storeCost.addCostItem('m', { Name: 'New' }).expressId;
    storeCost.assignCostItemsToSchedule('m', 40, [newItem]);

    const graph = cost.data('m');
    const primary = graph.Relationships.find(r => r.ref.expressId === primaryRel)!;
    const second = graph.Relationships.find(r => r.ref.expressId === secondRel)!;
    // The primary rel gained the new member but did NOT absorb `other` from
    // the second rel; the second rel is untouched.
    expect(primary.RelatedObjects?.map(o => o.expressId).sort()).toEqual([item, newItem].sort());
    expect(second.RelatedObjects?.map(o => o.expressId)).toEqual([other]);
  });

  it('assigns cost items to a schedule and appends on a second call rather than duplicating the rel', async () => {
    const { storeCost, cost } = await session();
    const itemA = storeCost.addCostItem('m', { Name: 'A' }).expressId;
    const itemB = storeCost.addCostItem('m', { Name: 'B' }).expressId;
    const rel1 = storeCost.assignCostItemsToSchedule('m', 40, [itemA]);
    const rel2 = storeCost.assignCostItemsToSchedule('m', 40, [itemB]);
    expect(rel2.expressId).toBe(rel1.expressId);
    const rel = cost.data('m').Relationships.find(r => r.ref.expressId === rel1.expressId)!;
    expect(rel.RelatedObjects?.map(r => r.expressId).sort()).toEqual([itemA, itemB].sort());
  });

  it('does not duplicate a member already listed in a SECOND existing rel for the same control', async () => {
    const { storeCost, cost, view } = await session();
    // Schedule #40 already controls #41 (fixture). Inject a SECOND, separate
    // IfcRelAssignsToControl for the same schedule controlling a different
    // item — legal STEP, and the case `findControlAssignment` used to miss
    // entirely (it only ever saw the first rel it found).
    const itemC = storeCost.addCostItem('m', { Name: 'C' }).expressId;
    const secondRel = view.createEntity('IfcRelAssignsToControl', [
      '0ctrl00000000000000002', null, null, null, [`#${itemC}`], null, '#40',
    ]).expressId;
    // Assigning #41 (already a member, but of the OTHER rel) again must not
    // add a second, duplicate membership anywhere.
    storeCost.assignCostItemsToSchedule('m', 40, [41]);
    const rels = cost.data('m').Relationships.filter(r => r.Type === 'IfcRelAssignsToControl' && r.RelatingControl?.expressId === 40);
    const allMembers = rels.flatMap(r => r.RelatedObjects?.map(o => o.expressId) ?? []);
    expect(allMembers.filter(id => id === 41)).toHaveLength(1);
    // The second rel and its own member are untouched.
    expect(cost.data('m').Relationships.some(r => r.ref.expressId === secondRel && r.RelatedObjects?.some(o => o.expressId === itemC))).toBe(true);
  });

  it('refuses to delete a value still referenced by an item, and detach:true rewrites CostValues to $ first', async () => {
    const { storeCost, cost, exportedGraph } = await session();
    const value = storeCost.addCostValue('m', { Name: 'V', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 1 } }).expressId;
    storeCost.setCostItemValues('m', 41, [value]);
    expect(() => storeCost.removeCostEntity('m', value)).toThrow(/still referenced/);

    storeCost.removeCostEntity('m', value, { detach: true });
    const pendingItem = cost.data('m').CostItems.find(i => i.ref.expressId === 41)!;
    expect(pendingItem.CostValues ?? []).toEqual([]);

    const exported = await exportedGraph();
    const exportedItem = exported.CostItems.find(i => i.ref.expressId === 41)!;
    expect(exportedItem.CostValues ?? []).toEqual([]);
  });

  it('refuses to delete an IfcCostValue still referenced via another value\'s AppliedValueRef, and detach:true clears it', async () => {
    const { storeCost, cost } = await session();
    // AppliedValueRef's target is normally an IfcMeasureWithUnit, but the
    // SELECT also admits another IfcAppliedValue/IfcCostValue — and that
    // target IS a recognised cost kind, so it is the one `removeCostEntity`
    // will actually let past the kind check to exercise the referrer guard.
    const target = storeCost.addCostValue('m', { Name: 'Target' }).expressId;
    const value = storeCost.addCostValue('m', { Name: 'V', AppliedValueRef: target }).expressId;
    expect(() => storeCost.removeCostEntity('m', target)).toThrow(/still referenced/);

    storeCost.removeCostEntity('m', target, { detach: true });
    const pendingValue = cost.data('m').CostValues.find(v => v.ref.expressId === value)!;
    expect(pendingValue.AppliedValue).toBeUndefined();
  });

  it('the generic relationship scan also covers IfcRelDeclares and IfcRelAssignsToProduct, not just IfcRelNests/IfcRelAssignsToControl', async () => {
    const { storeCost, cost, view } = await session();
    const item = storeCost.addCostItem('m', { Name: 'Declared item' }).expressId;
    // Neither rel type is one `removeCostEntityInStore` knows a positional
    // slot for — CostRemovalReferrers.otherRelationships is what has to pick
    // these up (walking every reference field, not a hand list of two types).
    const declares = view.createEntity('IfcRelDeclares', [
      '0decl000000000000000001', null, null, null, '#1', [`#${item}`],
    ]).expressId;
    const assignsToProduct = view.createEntity('IfcRelAssignsToProduct', [
      '0prod000000000000000002', null, null, null, [`#${item}`], null, '#1',
    ]).expressId;

    expect(() => storeCost.removeCostEntity('m', item)).toThrow(/still referenced by relationship/);

    storeCost.removeCostEntity('m', item, { detach: true });
    const graph = cost.data('m');
    expect(graph.CostItems.some(i => i.ref.expressId === item)).toBe(false);
    expect(graph.Relationships.some(r => r.ref.expressId === declares)).toBe(false);
    expect(graph.Relationships.some(r => r.ref.expressId === assignsToProduct)).toBe(false);
  });

  it('refuses to remove a non-cost entity (a wall) through removeCostEntity', async () => {
    const { storeCost } = await session();
    // #1 is IFCWALL in the fixture — not IfcCostSchedule/IfcCostItem/IfcCostValue.
    expect(() => storeCost.removeCostEntity('m', 1)).toThrow(/not an IfcCostSchedule\/IfcCostItem\/IfcCostValue/);
  });

  it('deleting a schedule that controls items tombstones the IfcRelAssignsToControl, not just the schedule', async () => {
    const { storeCost, cost } = await session();
    const schedule = storeCost.addCostSchedule('m', { Name: 'S' }).expressId;
    const item = storeCost.addCostItem('m', { Name: 'I' }).expressId;
    const relId = storeCost.assignCostItemsToSchedule('m', schedule, [item]).expressId;
    storeCost.removeCostEntity('m', schedule);
    const graph = cost.data('m');
    expect(graph.CostSchedules.some(s => s.ref.expressId === schedule)).toBe(false);
    expect(graph.Relationships.some(r => r.ref.expressId === relId)).toBe(false);
    expect(graph.CostItems.some(i => i.ref.expressId === item)).toBe(true); // the item itself survives
  });

  it('includeMutations:false still reports the on-disk graph, unaffected by pending authoring', async () => {
    const { storeCost, cost } = await session();
    storeCost.addCostItem('m', { Name: 'Not on disk' });
    const onDisk = cost.data('m', { includeMutations: false });
    expect(onDisk.CostItems.some(i => i.Name === 'Not on disk')).toBe(false);
    expect(onDisk.CostItems.some(i => i.ref.expressId === 41)).toBe(true);
  });
});

describe('bim.store cost authoring against the canonical manifest fixture (#4857)', () => {
  const path = fileURLToPath(new URL('../../../tests/models/cost/buildingsmart-cost-composition.ifc', import.meta.url));
  const available = existsSync(path);
  if (!available) console.warn('skip: canonical cost fixture missing — run `pnpm fixtures`');

  it.skipIf(!available)('adds a cost item to the real fixture and assigns it to the fixture\'s own schedule', async () => {
    const bytes = new Uint8Array(readFileSync(path));
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    const cost = createCostBackend(() => ({ modelId: 'm', store, mutationView: view }));
    const resolution: CostStoreModelResolution = { modelId: 'm', store, editor, ownerHistoryId: null };
    const storeCost = createCostStoreBackend(() => resolution, cost);

    const scheduleId = cost.data('m').CostSchedules[0]?.ref.expressId;
    expect(scheduleId).toBeDefined();
    const item = storeCost.addCostItem('m', { Name: 'Contingency' }).expressId;
    storeCost.assignCostItemsToSchedule('m', scheduleId!, [item]);
    const graph = cost.data('m');
    expect(graph.CostItems.some(i => i.ref.expressId === item && i.Name === 'Contingency')).toBe(true);
    expect(graph.Relationships.some(
      r => r.Type === 'IfcRelAssignsToControl' && r.RelatingControl?.expressId === scheduleId && r.RelatedObjects?.some(o => o.expressId === item),
    )).toBe(true);
  });
});
