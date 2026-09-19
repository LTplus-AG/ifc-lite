/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Loaded-model cost authoring (#4857 PR A). Builders, tested directly over a
 * `StoreEditor` on a minimal parsed store — the same pattern `apply-style.test.ts`
 * uses for an in-store builder with no coverage. The round trip through
 * `StepExporter` and `bim.cost.data()` is pinned in
 * `@ifc-lite/sdk`'s `cost-backend-authoring.test.ts`, which is the fixture-facing
 * end-to-end oracle; this file is the builder unit contract: exact attribute
 * layout, reparent/detach bookkeeping, and the safe-delete refusal.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import {
  addCostItemToStore, addCostScheduleToStore, addCostValueToStore,
  assignCostItemsToScheduleInStore, assignObjectsToCostItemInStore,
  attachCostValuesToItemInStore, nestCostItemsInStore, removeCostEntityInStore,
  type CostAnchor, type ExistingRelatedList,
} from './cost.js';

const MINIMAL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,$,#9);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#100=IFCWALL('guidA0000000000000000A',$,'WallA',$,$,$,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;`;

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

async function editor(): Promise<{ store: IfcDataStore; editor: StoreEditor; view: MutablePropertyView }> {
  const store = await parse(MINIMAL);
  const view = new MutablePropertyView(null, 'm');
  return { store, editor: new StoreEditor(store, view), view };
}

const ANCHOR: CostAnchor = { ownerHistoryId: null, schema: 'IFC4' };

describe('addCostScheduleToStore / addCostItemToStore / addCostValueToStore', () => {
  it('emits the IFC4 attribute layout in order', async () => {
    const { editor: ed } = await editor();
    const scheduleId = addCostScheduleToStore(ed, ANCHOR, { Name: 'Tender', PredefinedType: 'TENDER' });
    const valueId = addCostValueToStore(ed, ANCHOR, {
      Name: 'Rate', AppliedValue: { Type: 'IfcMonetaryMeasure', Value: 87.45 },
    });
    const itemId = addCostItemToStore(ed, ANCHOR, { Name: 'Facade', CostValues: [valueId] });

    const schedule = ed.getNewEntity(scheduleId)!;
    expect(schedule.type).toBe('IfcCostSchedule');
    expect(schedule.attributes[2]).toBe('Tender');
    expect(schedule.attributes[6]).toBe('.TENDER.');

    const value = ed.getNewEntity(valueId)!;
    expect(value.attributes[2]).toEqual({ typed: { type: 'IfcMonetaryMeasure', value: 87.45 } });

    const item = ed.getNewEntity(itemId)!;
    expect(item.attributes[7]).toEqual([`#${valueId}`]);
  });

  it('refuses IFC2X3 by name', async () => {
    const { editor: ed } = await editor();
    expect(() => addCostScheduleToStore(ed, { ownerHistoryId: null, schema: 'IFC2X3' }, { Name: 'x' }))
      .toThrow(/IFC2X3/);
  });

  it('refuses an empty CostValues array (absent vs empty)', async () => {
    const { editor: ed } = await editor();
    expect(() => addCostItemToStore(ed, ANCHOR, { Name: 'x', CostValues: [] })).toThrow(/at least one/);
  });

  it('refuses a value on a non-integer IfcInteger measure', async () => {
    const { editor: ed } = await editor();
    expect(() => addCostValueToStore(ed, ANCHOR, { AppliedValue: { Type: 'IfcInteger', Value: 1.5 } }))
      .toThrow(/integer/);
  });
});

describe('nestCostItemsInStore', () => {
  it('creates a fresh IfcRelNests when the parent has none yet', async () => {
    const { editor: ed } = await editor();
    const parent = addCostItemToStore(ed, ANCHOR, { Name: 'Parent' });
    const child = addCostItemToStore(ed, ANCHOR, { Name: 'Child' });
    const relId = nestCostItemsInStore(ed, ANCHOR, parent, [child], new Map());
    const rel = ed.getNewEntity(relId)!;
    expect(rel.type).toBe('IfcRelNests');
    expect(rel.attributes[4]).toBe(`#${parent}`);
    expect(rel.attributes[5]).toEqual([`#${child}`]);
  });

  it('appends to an existing target nest instead of creating a second one', async () => {
    const { editor: ed } = await editor();
    const parent = addCostItemToStore(ed, ANCHOR, { Name: 'Parent' });
    const existingChild = addCostItemToStore(ed, ANCHOR, { Name: 'Existing' });
    const newChild = addCostItemToStore(ed, ANCHOR, { Name: 'New' });
    const targetNest: ExistingRelatedList = { relId: 900, relatedIds: [existingChild] };
    const relId = nestCostItemsInStore(ed, ANCHOR, parent, [newChild], new Map(), targetNest);
    expect(relId).toBe(900);
    expect(ed.getNewEntity(900)).toBeNull(); // not overlay-created here (pre-existing source rel, id doesn't exist in overlay)
  });

  it('reparents: detaches a child from its old nest, tombstoning it when emptied', async () => {
    const { editor: ed } = await editor();
    const oldParent = addCostItemToStore(ed, ANCHOR, { Name: 'Old' });
    const newParent = addCostItemToStore(ed, ANCHOR, { Name: 'New' });
    const child = addCostItemToStore(ed, ANCHOR, { Name: 'Child' });
    const oldNestId = nestCostItemsInStore(ed, ANCHOR, oldParent, [child], new Map());

    const relId = nestCostItemsInStore(
      ed, ANCHOR, newParent, [child],
      new Map([[child, { relId: oldNestId, relatedIds: [child] }]]),
    );
    expect(relId).not.toBe(oldNestId);
    // The old (overlay-only) rel had exactly one member, so emptying it removes it outright.
    expect(ed.getNewEntity(oldNestId)).toBeNull();
    expect(ed.getNewEntities().some(e => e.expressId === oldNestId)).toBe(false);
  });
});

describe('assignCostItemsToScheduleInStore / assignObjectsToCostItemInStore', () => {
  it('writes RelatedObjects at slot 4 and RelatingControl at slot 6', async () => {
    const { editor: ed } = await editor();
    const schedule = addCostScheduleToStore(ed, ANCHOR, { Name: 'S' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const relId = assignCostItemsToScheduleInStore(ed, ANCHOR, schedule, [item]);
    const rel = ed.getNewEntity(relId)!;
    expect(rel.type).toBe('IfcRelAssignsToControl');
    expect(rel.attributes[4]).toEqual([`#${item}`]);
    expect(rel.attributes[6]).toBe(`#${schedule}`);
  });

  it('assigns a product AND a task to a cost item as legal RelatedObjects', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const relId = assignObjectsToCostItemInStore(ed, ANCHOR, item, [100, 200]);
    const rel = ed.getNewEntity(relId)!;
    expect(rel.attributes[4]).toEqual(['#100', '#200']);
    expect(rel.attributes[6]).toBe(`#${item}`);
  });
});

describe('attachCostValuesToItemInStore', () => {
  it('writes $ (null), never (), when clearing CostValues', async () => {
    const { editor: ed, view } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I', CostValues: [1] });
    attachCostValuesToItemInStore(ed, item, []);
    expect(view.getPositionalMutationsForEntity(item)?.get(7)).toBeNull();
  });

  it('replaces CostValues with the given list', async () => {
    const { editor: ed, view } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    attachCostValuesToItemInStore(ed, item, [1, 2]);
    expect(view.getPositionalMutationsForEntity(item)?.get(7)).toEqual(['#1', '#2']);
  });
});

describe('removeCostEntityInStore', () => {
  it('refuses to delete a value still listed in an IfcCostItem.CostValues', async () => {
    const { editor: ed } = await editor();
    const value = addCostValueToStore(ed, ANCHOR, { Name: 'V' });
    expect(() => removeCostEntityInStore(ed, ANCHOR, value, { itemCostValues: new Map([[41, [value]]]) }))
      .toThrow(/IfcCostItem #41\.CostValues/);
  });

  it('detach:true rewrites the referrer, writing $ when it empties, then deletes', async () => {
    const { editor: ed, view } = await editor();
    const value = addCostValueToStore(ed, ANCHOR, { Name: 'V' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I', CostValues: [value] });
    removeCostEntityInStore(
      ed, ANCHOR, value,
      { itemCostValues: new Map([[item, [value]]]) },
      { detach: true },
    );
    expect(view.getPositionalMutationsForEntity(item)?.get(7)).toBeNull();
    expect(ed.hasEntity(value)).toBe(false);
  });

  it('detaches from IfcRelNests and IfcRelAssignsToControl, tombstoning an emptied rel', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const nestId = nestCostItemsInStore(ed, ANCHOR, 900, [item], new Map());
    const assignId = assignObjectsToCostItemInStore(ed, ANCHOR, item, [100]);
    removeCostEntityInStore(ed, ANCHOR, item, {
      nestRelatedObjects: new Map([[nestId, [item]]]),
      assignmentRelatedObjects: new Map(), // the item's OWN assignment (assignId) controls #100, not the item as a related object
    });
    expect(ed.hasEntity(nestId)).toBe(false);
    expect(ed.hasEntity(item)).toBe(false);
    expect(ed.hasEntity(assignId)).toBe(true); // untouched: the item was RelatingControl there, not RelatedObjects
  });

  it('cascades to values referenced only by the removed item', async () => {
    const { editor: ed } = await editor();
    const value = addCostValueToStore(ed, ANCHOR, { Name: 'V' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I', CostValues: [value] });
    removeCostEntityInStore(ed, ANCHOR, item, {}, { cascadeValueIds: [value] });
    expect(ed.hasEntity(item)).toBe(false);
    expect(ed.hasEntity(value)).toBe(false);
  });

  it('refuses IFC2X3', async () => {
    const { editor: ed } = await editor();
    expect(() => removeCostEntityInStore(ed, { ownerHistoryId: null, schema: 'IFC2X3' }, 1, {}))
      .toThrow(/IFC2X3/);
  });
});
