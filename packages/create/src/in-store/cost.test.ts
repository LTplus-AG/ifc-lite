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
// Through the package barrel, not `./cost.js` directly: the revert oracle
// (`scripts/check-test-revert-oracle.mjs`) reverts `in-store/cost.ts` by
// deleting it outright (it is brand new), which would make a direct import
// unresolvable at load time — a dead import, not a RED assertion. Routed
// through `../index.js` (an EXISTING file whose diff only ADDS export
// lines), a revert instead removes the re-export and every call below fails
// as an ordinary "X is not a function" — the assertion-level signal the
// oracle is designed to read. See cost-backend-mutations.test.ts for the
// companion witness that does not depend on this file at all.
import {
  addCostItemToStore, addCostQuantityToStore, addCostScheduleToStore, addCostValueToStore,
  assignCostItemsToScheduleInStore, assignObjectsToCostItemInStore,
  attachCostValuesToItemInStore, nestCostItemsInStore, removeCostEntityInStore,
  type CostAnchor, type ExistingRelatedList,
} from '../index.js';

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

  it('resolves constructor references before writing them: addCostItem.CostValues/CostQuantities, addCostValue.AppliedValueRef/UnitBasis/Components, addCostQuantity.Unit', async () => {
    const { editor: ed } = await editor();
    expect(() => addCostItemToStore(ed, ANCHOR, { Name: 'I', CostValues: [100] }))
      .toThrow(/CostValues #100 must be one of IFCCOSTVALUE, IFCAPPLIEDVALUE, got IFCWALL/);
    expect(() => addCostItemToStore(ed, ANCHOR, { Name: 'I', CostQuantities: [100] }))
      .toThrow(/CostQuantities #100 must be one of/);
    expect(() => addCostValueToStore(ed, ANCHOR, { AppliedValueRef: 100 }))
      .toThrow(/AppliedValueRef #100 must be one of/);
    expect(() => addCostValueToStore(ed, ANCHOR, { UnitBasis: 100 }))
      .toThrow(/UnitBasis #100 must be an IfcMeasureWithUnit, got IFCWALL/);
    expect(() => addCostValueToStore(ed, ANCHOR, { Components: [100] }))
      .toThrow(/Components #100 must be one of/);
    expect(() => addCostQuantityToStore(ed, ANCHOR, { Kind: 'IfcQuantityLength', Name: 'Q', Value: 1, Unit: 99999 }))
      .toThrow(/Unit #99999 does not exist/);
  });

  it('refuses a PredefinedType outside the enum, on a schedule, an item, and an ArithmeticOperator on a value', async () => {
    const { editor: ed } = await editor();
    expect(() => addCostScheduleToStore(ed, ANCHOR, { Name: 'S', PredefinedType: 'BOGUS' as never }))
      .toThrow(/PredefinedType/);
    expect(() => addCostItemToStore(ed, ANCHOR, { Name: 'I', PredefinedType: 'BOGUS' as never }))
      .toThrow(/PredefinedType/);
    expect(() => addCostValueToStore(ed, ANCHOR, { ArithmeticOperator: 'BOGUS' as never }))
      .toThrow(/ArithmeticOperator/);
  });
});

describe('addCostQuantityToStore', () => {
  it('IFC4X3 IfcQuantityCount serializes as an INTEGER literal, not a REAL one', async () => {
    const { editor: ed } = await editor();
    const id = addCostQuantityToStore(ed, { ownerHistoryId: null, schema: 'IFC4X3' }, { Kind: 'IfcQuantityCount', Name: 'N', Value: 5 });
    // The `{ real }` overlay marker always forces a trailing decimal point
    // (`5.`), which is what IFC4X3's INTEGER-typed IfcCountMeasure must NOT
    // get — a bare `5` is the correct STEP token here.
    expect(ed.getNewEntity(id)!.attributes[3]).toBe(5);
  });

  it('a non-count (or non-IFC4X3) quantity still forces a REAL literal even for a whole number', async () => {
    const { editor: ed } = await editor();
    const id = addCostQuantityToStore(ed, ANCHOR, { Kind: 'IfcQuantityLength', Name: 'N', Value: 5 });
    expect(ed.getNewEntity(id)!.attributes[3]).toEqual({ real: 5 });
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
      new Map([[child, [{ relId: oldNestId, relatedIds: [child] }]]]),
    );
    expect(relId).not.toBe(oldNestId);
    // The old (overlay-only) rel had exactly one member, so emptying it removes it outright.
    expect(ed.getNewEntity(oldNestId)).toBeNull();
    expect(ed.getNewEntities().some(e => e.expressId === oldNestId)).toBe(false);
  });

  it('reparents TWO children out of the SAME old nest in one call without resurrecting the first', async () => {
    const { editor: ed } = await editor();
    const oldParent = addCostItemToStore(ed, ANCHOR, { Name: 'Old' });
    const newParent = addCostItemToStore(ed, ANCHOR, { Name: 'New' });
    const childA = addCostItemToStore(ed, ANCHOR, { Name: 'A' });
    const childB = addCostItemToStore(ed, ANCHOR, { Name: 'B' });
    const oldNestId = nestCostItemsInStore(ed, ANCHOR, oldParent, [childA, childB], new Map());
    const oldNest: ExistingRelatedList = { relId: oldNestId, relatedIds: [childA, childB] };

    nestCostItemsInStore(
      ed, ANCHOR, newParent, [childA, childB],
      new Map([[childA, [oldNest]], [childB, [oldNest]]]),
    );
    // Both children left; the old rel is emptied and tombstoned, not left
    // holding one of them back from a filter that only looked at ONE child
    // per rewrite (the bug: re-filtering the unchanged original list on the
    // second child's iteration would undo the first child's removal).
    expect(ed.hasEntity(oldNestId)).toBe(false);
  });

  it('reparents a child that is a member of TWO different IfcRelNests, detaching from BOTH', async () => {
    const { editor: ed, view } = await editor();
    const newParent = addCostItemToStore(ed, ANCHOR, { Name: 'New' });
    const child = addCostItemToStore(ed, ANCHOR, { Name: 'Child' });
    // A file may legally list the same child under more than one nest
    // (MULTIPLE_NESTING_PARENTS is a diagnostic, not a refusal); the caller's
    // resolver hands in every one it found.
    const nestX: ExistingRelatedList = { relId: 900, relatedIds: [child] };
    const nestY: ExistingRelatedList = { relId: 901, relatedIds: [child, 902] };

    nestCostItemsInStore(ed, ANCHOR, newParent, [child], new Map([[child, [nestX, nestY]]]));

    // nestX had only the child, so it is tombstoned; nestY keeps its other
    // member (902) with the child removed — the bug this pins: a byChild map
    // that only remembers ONE of the two rels would leave nestY untouched,
    // so the child would still read as nested there too.
    expect(ed.hasEntity(900)).toBe(false);
    expect(view.getPositionalMutationsForEntity(901)?.get(5)).toEqual(['#902']);
  });

  it('refuses parentId === one of childIds (self-nesting)', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    expect(() => nestCostItemsInStore(ed, ANCHOR, item, [item], new Map()))
      .toThrow(/cannot also be one of childIds/);
  });

  it('refuses a parentId or childId that is not an IfcCostItem', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    expect(() => nestCostItemsInStore(ed, ANCHOR, 100, [item], new Map()))
      .toThrow(/parentId #100 must be an IfcCostItem, got IFCWALL/);
    expect(() => nestCostItemsInStore(ed, ANCHOR, item, [100], new Map()))
      .toThrow(/childId #100 must be an IfcCostItem, got IFCWALL/);
  });

  it('de-duplicates childIds when creating a fresh IfcRelNests', async () => {
    const { editor: ed } = await editor();
    const parent = addCostItemToStore(ed, ANCHOR, { Name: 'Parent' });
    const child = addCostItemToStore(ed, ANCHOR, { Name: 'Child' });
    const relId = nestCostItemsInStore(ed, ANCHOR, parent, [child, child], new Map());
    expect(ed.getNewEntity(relId)!.attributes[5]).toEqual([`#${child}`]);
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
    // #100 (IfcWall, the fixture's product) and a freshly authored IfcTask —
    // assignObjectsToCostItemInStore does not type-check RelatedObjects
    // (products AND tasks are legal), but it does now require they EXIST.
    const task = ed.addEntity('IfcTask', ['0task00000000000000001', null, 'T', null, null, null, null, null, '.NOTDEFINED.', null, null, null]).expressId;
    const relId = assignObjectsToCostItemInStore(ed, ANCHOR, item, [100, task]);
    const rel = ed.getNewEntity(relId)!;
    expect(rel.attributes[4]).toEqual(['#100', `#${task}`]);
    expect(rel.attributes[6]).toBe(`#${item}`);
  });

  it('de-duplicates relatedObjectIds when creating a fresh IfcRelAssignsToControl', async () => {
    const { editor: ed } = await editor();
    const schedule = addCostScheduleToStore(ed, ANCHOR, { Name: 'S' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const relId = assignCostItemsToScheduleInStore(ed, ANCHOR, schedule, [item, item]);
    expect(ed.getNewEntity(relId)!.attributes[4]).toEqual([`#${item}`]);
  });

  it('refuses a relatingControlId of the wrong class, and a relatedObjectId that does not exist', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    expect(() => assignCostItemsToScheduleInStore(ed, ANCHOR, 100, [item]))
      .toThrow(/relatingControlId #100 must be an IfcCostSchedule, got IFCWALL/);
    expect(() => assignObjectsToCostItemInStore(ed, ANCHOR, item, [99999]))
      .toThrow(/relatedObjectIds #99999 does not exist/);
  });
});

describe('attachCostValuesToItemInStore', () => {
  it('writes $ (null), never (), when clearing CostValues', async () => {
    const { editor: ed, view } = await editor();
    const value = addCostValueToStore(ed, ANCHOR, { Name: 'V' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I', CostValues: [value] });
    attachCostValuesToItemInStore(ed, item, []);
    expect(view.getPositionalMutationsForEntity(item)?.get(7)).toBeNull();
  });

  it('replaces CostValues with the given list', async () => {
    const { editor: ed, view } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const v1 = addCostValueToStore(ed, ANCHOR, { Name: 'V1' });
    const v2 = addCostValueToStore(ed, ANCHOR, { Name: 'V2' });
    attachCostValuesToItemInStore(ed, item, [v1, v2]);
    expect(view.getPositionalMutationsForEntity(item)?.get(7)).toEqual([`#${v1}`, `#${v2}`]);
  });

  it('refuses an itemId that is not an IfcCostItem, and a valueId that is not an IfcCostValue', async () => {
    const { editor: ed } = await editor();
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const value = addCostValueToStore(ed, ANCHOR, { Name: 'V' });
    expect(() => attachCostValuesToItemInStore(ed, 100, [value])).toThrow(/itemId #100 must be an IfcCostItem, got IFCWALL/);
    expect(() => attachCostValuesToItemInStore(ed, item, [100])).toThrow(/CostValues #100 must be an IfcCostValue, got IFCWALL/);
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
    const parent = addCostItemToStore(ed, ANCHOR, { Name: 'Parent' });
    const nestId = nestCostItemsInStore(ed, ANCHOR, parent, [item], new Map());
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

  it('tombstones an IfcRelNests where the target is the (required) nesting parent, not a related object', async () => {
    const { editor: ed } = await editor();
    const parent = addCostItemToStore(ed, ANCHOR, { Name: 'Parent' });
    const child = addCostItemToStore(ed, ANCHOR, { Name: 'Child' });
    const nestId = nestCostItemsInStore(ed, ANCHOR, parent, [child], new Map());
    removeCostEntityInStore(ed, ANCHOR, parent, { nestsAsParent: [nestId] });
    expect(ed.hasEntity(nestId)).toBe(false);
    expect(ed.hasEntity(parent)).toBe(false);
    expect(ed.hasEntity(child)).toBe(true); // the child itself is untouched, only the now-orphaned rel is
  });

  it('tombstones an IfcRelAssignsToControl where the target is the (required) RelatingControl', async () => {
    const { editor: ed } = await editor();
    const schedule = addCostScheduleToStore(ed, ANCHOR, { Name: 'S' });
    const item = addCostItemToStore(ed, ANCHOR, { Name: 'I' });
    const relId = assignCostItemsToScheduleInStore(ed, ANCHOR, schedule, [item]);
    removeCostEntityInStore(ed, ANCHOR, schedule, { assignmentsAsControl: [relId] });
    expect(ed.hasEntity(relId)).toBe(false);
    expect(ed.hasEntity(schedule)).toBe(false);
    expect(ed.hasEntity(item)).toBe(true);
  });
});
