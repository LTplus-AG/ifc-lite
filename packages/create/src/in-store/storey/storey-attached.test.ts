/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9296 round 1A: storey levels drive the elements that depend on them.
 * Columns (grid-bound included), beams, curtain walls and stair railings
 * follow a storey edit; an inserted storey re-binds relative attachments and
 * leaves explicit ones; a wall top can attach to a slab's underside; copies
 * to other storeys re-resolve their attachments, in one undoable operation.
 * Built the way the Model workspace builds a house from "Start blank".
 */

import { describe, expect, it } from 'vitest';
import { recordCompoundMutation, undoRecordedMutationOperations, StoreEditor } from '@ifc-lite/mutations';
import { PropertyValueType } from '@ifc-lite/data';
import * as create from '../../index.js';
import { IfcCreator } from '../../ifc-creator.js';
import { addOrdinaryElementInStore } from '../ordinary-element.js';
import { addHostedElementInStore } from '../hosted-element.js';
import { addCurtainWallToStore } from '../curtain-wall.js';
import { readCurtainWallParts } from '../curtain-wall-relayout.js';
import { addGridToStore } from '../grid.js';
import { addColumnOnGridToStore } from '../grid-column.js';
import { addStairToStore } from '../stair.js';
import { addRailingToStore } from '../railing.js';
import { readStairDimensions } from '../stair-edit.js';
import { resolveSpatialAnchor, AnchorEntityReader } from '../resolve-anchor.js';
import { pointOf, refId } from '../host-geometry-frame.js';
import { readAttachedTop, type AttachedKind } from './storey-attached.js';
import { resolveLinearElementChain } from '../edit/linear-element-edit.js';
import { parse, session, type Session } from '../__test__/storey-fixtures.oracle.js';

const { readStoreyInventory, addStoreyInStore, applyStoreyLevelEdit, planStoreyLevelEdit, writeTopAttachment, readTopAttachment } = create;
const PSET = create.STOREY_ATTACHMENT_PSET;

interface Levels extends Session { l1: number; l2: number; l3: number; guid: (storey: number) => string }

/** Level 1 at 0, Level 2 at 3, Level 3 at 6. */
async function levels(): Promise<Levels> {
  const creator = new IfcCreator({ Name: 'Blank' });
  creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
  const s = session(await parse(creator.toIfc().content));
  const l1 = readStoreyInventory(s.store, s.view).storeys[0].expressId;
  const l2 = addStoreyInStore(s.store, s.editor, { Name: 'Level 2', Elevation: 3 }).storeyId;
  const l3 = addStoreyInStore(s.store, s.editor, { Name: 'Level 3', Elevation: 6 }).storeyId;
  const guid = (storey: number) => readStoreyInventory(s.store, s.view).storeys.find((x) => x.expressId === storey)!.GlobalId;
  return { ...s, l1, l2, l3, guid };
}

const anchor = (s: Session, storey: number) => (draft: StoreEditor) => resolveSpatialAnchor(s.store, storey, draft.getMutationView());
const target = (s: Session) => ({ dataStore: s.store, view: s.view, editor: s.editor });
const top = (s: Session, id: number, kind: AttachedKind) => readAttachedTop(target(s), id, kind);
const wall = (s: Session, storey: number, y: number, Height = 3) =>
  addOrdinaryElementInStore(s.editor, anchor(s, storey), { kind: 'wall', params: { Start: [0, y, 0], End: [6, y, 0], Thickness: 0.2, Height } });
const raise = (s: Levels, storeyId: number, Height: number) => applyStoreyLevelEdit(s.store, s.editor, { kind: 'floorHeight', storeyId, Height });

/** Lift an element's single body solid `dz` (file units) above its placement, as some exporters write it. */
function liftSolid(s: Session, id: number, dz: number): void {
  const reader = new AnchorEntityReader(s.store, s.view);
  const shape = reader.entity(refId(reader.entity(id)!.attributes[6])!)!;
  const rep = reader.entity(refId((shape.attributes[2] as unknown[])[0])!)!;
  const solid = refId((rep.attributes[3] as unknown[])[0])!;
  const point = s.editor.addEntity('IfcCartesianPoint', [[0, 0, dz]]).expressId;
  const position = s.editor.addEntity('IfcAxis2Placement3D', [`#${point}`, null, null]).expressId;
  s.editor.setPositionalAttribute(solid, 1, `#${position}`);
}

describe('columns, beams and curtain walls follow their level (#9296)', () => {
  it('a column attached to the storey above follows a floor-to-floor edit; a fixed one keeps its height', async () => {
    const s = await levels();
    const column = (x: number) => addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [x, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 } });
    const attached = column(0), fixed = column(3);
    writeTopAttachment(s.view, attached, s.guid(s.l2));
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'floorHeight', storeyId: s.l1, Height: 6 });
    expect(plan.refusals).toEqual([]);
    expect(plan.attached).toEqual([expect.objectContaining({ elementId: attached, kind: 'column', from: 3, to: 6 })]);
    const result = raise(s, s.l1, 6);
    expect(result.reshaped).toContain(attached);
    expect(top(s, attached, 'column')).toBeCloseTo(6, 9);
    expect(top(s, fixed, 'column')).toBeCloseTo(3, 9);
  });

  it('a column bound to a grid crossing follows too, and keeps its crossing', async () => {
    const s = await levels();
    const grid = s.editor.runAtomic((draft) => addGridToStore(draft, anchor(s, s.l1)(draft), {
      UAxes: [{ Tag: 'A', Start: [0, -1], End: [0, 7] }, { Tag: 'B', Start: [6, -1], End: [6, 7] }],
      VAxes: [{ Tag: '1', Start: [-1, 0], End: [7, 0] }],
    }));
    const column = s.editor.runAtomic((draft) => addColumnOnGridToStore(draft, s.store, anchor(s, s.l1)(draft),
      { Position: [6, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 }, { GridId: grid.gridId, IntersectingAxes: [grid.uAxisIds[1], grid.vAxisIds[0]] })).columnId;
    // The authoring default reads the top through the grid placement it hangs from.
    create.applyNewElementTop(s.store, s.editor, column, 'auto', s.l1);
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), column)).toMatchObject({ targetStoreyId: s.l2, binding: 'relative' });
    const placement = new AnchorEntityReader(s.store, s.view).entity(column)?.attributes[5];
    raise(s, s.l1, 6);
    expect(top(s, column, 'column')).toBeCloseTo(6, 9);
    expect(new AnchorEntityReader(s.store, s.view).entity(column)?.attributes[5]).toEqual(placement);
  });

  it('refuses, before writing, an edit that would leave an attached column no height', async () => {
    const s = await levels();
    const column = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [0, 0, 1], Width: 0.4, Depth: 0.4, Height: 2 } });
    writeTopAttachment(s.view, column, s.guid(s.l2));
    const before = s.snapshot();
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'floorHeight', storeyId: s.l1, Height: 1 });
    expect(plan.refusals).toEqual([expect.objectContaining({ code: 'dependent', elementIds: [column] })]);
    expect(plan.refusals[0].message).toMatch(/Column #\d+ would end 0\.00 m tall/);
    expect(() => raise(s, s.l1, 1)).toThrow(create.StoreyEditRefusedError);
    expect(s.snapshot()).toEqual(before);
  });

  it('a level beam under the storey above rises with it; a brace keeps its foot and reaches the new level', async () => {
    const s = await levels();
    const beam = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'beam', params: { Start: [0, 0, 2.8], End: [6, 0, 2.8], Width: 0.3, Height: 0.4 } });
    const brace = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'member', params: { Start: [0, 2, 0], End: [4, 2, 3], Width: 0.2, Height: 0.2 } });
    writeTopAttachment(s.view, beam, s.guid(s.l2));
    writeTopAttachment(s.view, brace, s.guid(s.l2));
    raise(s, s.l1, 4);
    expect(top(s, beam, 'linear')).toBeCloseTo(3.8, 9);
    expect(top(s, brace, 'linear')).toBeCloseTo(4, 9);
    const chain = resolveLinearElementChain(s.store, s.view, s.editor, brace, 1)!;
    expect(chain.startCoordinates).toEqual([0, 2, 0]);
    expect(chain.depth).toBeCloseTo(Math.hypot(4, 4), 9);
  });

  it('a curtain wall is laid out again at the new height, every part kept', async () => {
    const s = await levels();
    const built = s.editor.runAtomic((draft) => addCurtainWallToStore(draft, anchor(s, s.l1)(draft), { Start: [0, 0, 0], End: [6, 0, 0], Height: 3, UGrid: 4, VGrid: 2 }));
    writeTopAttachment(s.view, built.curtainWallId, s.guid(s.l2));
    raise(s, s.l1, 4);
    const after = readCurtainWallParts(target(s), built.curtainWallId)!;
    expect(after.height).toBeCloseTo(4, 9);
    const expected = create.curtainWallLayout({ Start: [0, 0, 0], End: [6, 0, 0], Height: 4, UGrid: 4, VGrid: 2 });
    const parts = new Map(after.parts.map((part) => [part.id, part]));
    built.transomIds.forEach((id, i) => expect(parts.get(id)!.v).toBeCloseTo(expected.transoms[i].v, 9));
    built.panelIds.forEach((id, i) => {
      expect(parts.get(id)!.v).toBeCloseTo(expected.panels[i].v0, 9);
      expect(parts.get(id)!.depth).toBeCloseTo(expected.panels[i].v1 - expected.panels[i].v0, 9);
    });
    built.mullionIds.forEach((id) => expect(parts.get(id)!.depth).toBeCloseTo(4, 9));
  });
});

describe('round-2 review of #9340', () => {
  it('fits a column whose solid starts above its placement by where the solid starts', async () => {
    const s = await levels();
    const column = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [0, 0, 0], Width: 0.4, Depth: 0.4, Height: 1.5 } });
    liftSolid(s, column, 1);
    create.setTopConstraintInStore(s.store, s.editor, column, { kind: 'storeyAbove' });
    // Base at 1 m, so reaching Level 2 at 3 m takes a 2 m body, not 3 m.
    expect(top(s, column, 'column')).toBeCloseTo(2, 9);
  });

  it('a copy whose body cannot be read is still re-bound to the storey above its new one', async () => {
    const s = await levels();
    const beam = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'beam', params: { Start: [0, 0, 2.8], End: [6, 0, 2.8], Width: 0.3, Height: 0.4 } });
    writeTopAttachment(s.view, beam, s.guid(s.l2), 'relative');
    liftSolid(s, beam, 0.1);
    expect(top(s, beam, 'linear')).toBeNull();
    const [copy] = create.copyBatchInStore(s.store, s.editor, [beam], [{ targetStoreyId: s.l2 }]);
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)?.targetStoreyId).toBe(s.l3);
  });

  it('V-grid lines given at heights that do not divide the wall equally keep their heights', async () => {
    const s = await levels();
    const built = s.editor.runAtomic((draft) => addCurtainWallToStore(draft, anchor(s, s.l1)(draft), { Start: [0, 0, 0], End: [6, 0, 0], Height: 3, UGrid: 2, VGrid: [0.9, 2.1] }));
    writeTopAttachment(s.view, built.curtainWallId, s.guid(s.l2));
    raise(s, s.l1, 4);
    const after = readCurtainWallParts(target(s), built.curtainWallId)!;
    const rows = [...new Set(after.parts.filter((p) => p.role === 'transom').map((p) => Math.round(p.v * 1e6) / 1e6))].sort((a, b) => a - b);
    expect(after.height).toBeCloseTo(4, 9);
    expect(rows.slice(1, -1)).toEqual([0.9, 2.1]);
  });
});

describe('a railing on a stair refits with it (#9296)', () => {
  it('stretches along the new run and up the new rise; a railing elsewhere stays', async () => {
    const s = await levels();
    const stair = s.editor.runAtomic((draft) => addStairToStore(draft, anchor(s, s.l1)(draft), {
      Position: [6, 1, 0], Direction: Math.PI / 2, NumberOfRisers: 17, RiserHeight: 3 / 17, TreadLength: 0.27, Width: 1,
    }));
    const run = 17 * 0.27;
    const on = s.editor.runAtomic((draft) => addRailingToStore(draft, anchor(s, s.l1)(draft), { Path: [[6.05, 1, 0], [6.05, 1 + run, 3]], Height: 0.9 })).railingId;
    const off = s.editor.runAtomic((draft) => addRailingToStore(draft, anchor(s, s.l1)(draft), { Path: [[0, 0, 0], [3, 0, 0]], Height: 0.9 })).railingId;
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'floorHeight', storeyId: s.l1, Height: 3.3 });
    expect(plan.railings).toEqual([{ railingId: on, stairId: stair.stairId }]);
    const result = raise(s, s.l1, 3.3);
    expect(result.reshaped).toContain(on);
    const dims = readStairDimensions(s.store, stair.stairId, s.view)!;
    const directrix = (railing: number) => {
      const reader = new AnchorEntityReader(s.store, s.view);
      const shape = reader.entity(refId(reader.entity(railing)!.attributes[6])!)!;
      const rep = reader.entity(refId((shape.attributes[2] as unknown[])[0])!)!;
      const disk = reader.entity(refId((rep.attributes[3] as unknown[])[0])!)!;
      return (reader.entity(refId(disk.attributes[0])!)!.attributes[0] as unknown[]).map((p) => pointOf(reader, p)!);
    };
    const [foot, head] = directrix(on);
    // Railing-local: the path starts at the stair foot, the axis sits Height − radius above it.
    expect(foot).toEqual([0, 0, 0.875]);
    expect(head[1]).toBeCloseTo(dims.NumberOfRisers * dims.TreadLength, 9);
    expect(head[2]).toBeCloseTo(3.3 + 0.875, 9);
    expect(directrix(off)[1]).toEqual([3, 0, 0.875]);
  });
});

describe('inserting a storey re-binds relative attachments (#9296)', () => {
  it('"home storey + 1" re-binds to the inserted storey and keeps its offset; an explicit binding stays', async () => {
    const s = await levels();
    const relative = wall(s, s.l1, 0), explicit = wall(s, s.l1, 2), offset = wall(s, s.l1, 4, 2.8);
    // A record written before #9296: the next storey's GlobalId alone reads as relative.
    s.view.setProperty(relative, PSET, 'TopConstraint', s.guid(s.l2), PropertyValueType.Label);
    writeTopAttachment(s.view, explicit, s.guid(s.l2), 'explicit');
    writeTopAttachment(s.view, offset, s.guid(s.l2), 'relative');
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), relative)?.binding).toBe('relative');
    const plan = create.planStoreyAdd(readStoreyInventory(s.store, s.view), { Name: 'Mezzanine', Elevation: 1.5 });
    expect(plan.refusal).toBeNull();
    expect(plan.bindings.map((b) => [b.elementId, b.previousTargetId])).toEqual([[relative, s.l2], [offset, s.l2]]);
    expect(plan.bindings.map((b) => b.to)).toEqual([expect.closeTo(1.5, 9), expect.closeTo(1.3, 9)]);
    const added = addStoreyInStore(s.store, s.editor, { Name: 'Mezzanine', Elevation: 1.5 });
    const inventory = readStoreyInventory(s.store, s.view);
    expect(readTopAttachment(inventory, relative)?.targetStoreyId).toBe(added.storeyId);
    expect(readTopAttachment(inventory, explicit)?.targetStoreyId).toBe(s.l2);
    expect(top(s, relative, 'wall')).toBeCloseTo(1.5, 9);
    expect(top(s, offset, 'wall')).toBeCloseTo(1.3, 9);
    expect(top(s, explicit, 'wall')).toBeCloseTo(3, 9);
  });

  it('an attachment that names a storey further up is explicit and is not re-bound', async () => {
    const s = await levels();
    const tall = wall(s, s.l1, 0, 6);
    s.view.setProperty(tall, PSET, 'TopConstraint', s.guid(s.l3), PropertyValueType.Label);
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), tall)?.binding).toBe('explicit');
    addStoreyInStore(s.store, s.editor, { Name: 'Mezzanine', Elevation: 1.5 });
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), tall)?.targetStoreyId).toBe(s.l3);
    expect(top(s, tall, 'wall')).toBeCloseTo(6, 9);
  });

  it('refuses an insert that would leave a re-bound element no height, writing nothing; the dry run says so first (#9340 review)', async () => {
    const s = await levels();
    const raised = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [0, 0, 1], Width: 0.4, Depth: 0.4, Height: 2 } });
    writeTopAttachment(s.view, raised, s.guid(s.l2), 'relative');
    const before = s.snapshot();
    expect(create.planStoreyAdd(readStoreyInventory(s.store, s.view), { Name: 'Low', Elevation: 0.5 }).refusal).toMatch(/cannot reach the new storey/);
    expect(s.snapshot()).toEqual(before);
    expect(() => addStoreyInStore(s.store, s.editor, { Name: 'Low', Elevation: 0.5 })).toThrow(/cannot reach the new storey/);
    expect(s.snapshot()).toEqual(before);
  });
});

describe('a wall top attached to a slab underside (#9296)', () => {
  it('ends on the slab underside and follows it when the slab storey moves', async () => {
    const s = await levels();
    const slab = addOrdinaryElementInStore(s.editor, anchor(s, s.l2), { kind: 'slab', params: { Position: [0, 4, 0], Width: 5, Depth: 2, Thickness: 0.3, ExtrudedDirection: [0, 0, -1] } });
    const under = wall(s, s.l1, 5, 3.4);
    create.setTopConstraintInStore(s.store, s.editor, under, { kind: 'slab', slabId: slab });
    expect(top(s, under, 'wall')).toBeCloseTo(2.7, 9);
    applyStoreyLevelEdit(s.store, s.editor, { kind: 'elevation', storeyId: s.l2, Elevation: 3.4 });
    expect(top(s, under, 'wall')).toBeCloseTo(3.1, 9);
  });

  it('a roof target is reported, not followed', async () => {
    const s = await levels();
    const roof = addOrdinaryElementInStore(s.editor, anchor(s, s.l2), { kind: 'roof', params: { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.2 } });
    const under = wall(s, s.l1, 0);
    const guid = new AnchorEntityReader(s.store, s.view).entity(roof)!.attributes[0] as string;
    writeTopAttachment(s.view, under, guid);
    const plan = planStoreyLevelEdit(readStoreyInventory(s.store, s.view), { kind: 'floorHeight', storeyId: s.l1, Height: 4 });
    expect(plan.notices.find((notice) => notice.code === 'wallAttachmentUnresolved')?.message).toMatch(/a roof \(attaching to a roof is not supported yet\)/);
  });
});

describe('copies to other storeys re-resolve their attachments (#9296)', () => {
  it('a relative top attaches to the storey above the copy, its height following the new floor-to-floor', async () => {
    const s = await levels();
    const l4 = addStoreyInStore(s.store, s.editor, { Name: 'Level 4', Elevation: 10 }).storeyId;
    const source = wall(s, s.l1, 0);
    addHostedElementInStore(s.store, s.editor, source, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } });
    writeTopAttachment(s.view, source, s.guid(s.l2), 'relative');
    const copies = create.copyToStoreysInStore(s.store, s.editor, [source], [s.l2, s.l3]);
    expect(copies.map((c) => c.storeyId)).toEqual([s.l2, s.l3]);
    const inventory = readStoreyInventory(s.store, s.view);
    const [onL2, onL3] = copies.map((c) => c.results[0].copyId);
    expect(readTopAttachment(inventory, onL2)).toMatchObject({ targetStoreyId: s.l3, binding: 'relative' });
    expect(readTopAttachment(inventory, onL3)).toMatchObject({ targetStoreyId: l4, binding: 'relative' });
    expect(top(s, onL2, 'wall')).toBeCloseTo(3, 9);
    expect(top(s, onL3, 'wall')).toBeCloseTo(4, 9);
    expect(copies[1].results[0].fillingIds).toHaveLength(1);
  });

  it('copies to N storeys are one undoable operation', async () => {
    const s = await levels();
    const source = wall(s, s.l1, 0);
    writeTopAttachment(s.view, source, s.guid(s.l2), 'relative');
    const before = s.snapshot();
    const copies = recordCompoundMutation(s.view, (draft) => create.copyToStoreysInStore(s.store, new StoreEditor(s.store, draft), [source], [s.l2, s.l3]));
    expect(copies).toHaveLength(2);
    // One compound record undoes every storey's copies.
    undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound edit expected'); });
    expect(s.snapshot()).toEqual(before);
  });

  it('refuses a copy whose explicit top would not be above its new storey, writing nothing', async () => {
    const s = await levels();
    const source = wall(s, s.l1, 0);
    writeTopAttachment(s.view, source, s.guid(s.l2), 'explicit');
    const before = s.snapshot();
    expect(() => create.copyToStoreysInStore(s.store, s.editor, [source], [s.l2])).toThrow(/attached to Level 2, which is not above its new storey Level 2/);
    expect(s.snapshot()).toEqual(before);
  });

  it('a single copyProductInStore re-binds as the batch does (#9340 review)', async () => {
    const s = await levels();
    const source = wall(s, s.l1, 0);
    writeTopAttachment(s.view, source, s.guid(s.l2), 'relative');
    const copy = s.editor.runAtomic((draft) => create.copyProductInStore(create.createCopyContext(s.store, draft), source, { targetStoreyId: s.l2 }));
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)?.targetStoreyId).toBe(s.l3);
  });

  it('keeps the copyElements transform-list call shape', async () => {
    const s = await levels();
    const source = wall(s, s.l1, 0);
    writeTopAttachment(s.view, source, s.guid(s.l2));
    const [copy] = create.copyBatchInStore(s.store, s.editor, [source], [{ targetStoreyId: s.l2 }]);
    expect(readTopAttachment(readStoreyInventory(s.store, s.view), copy.copyId)?.targetStoreyId).toBe(s.l3);
  });
});

describe('the bim.store authoring default (#9296)', () => {
  it('attaches an element drawn to the storey above relatively; any other height stays fixed', async () => {
    const s = await levels();
    const reaches = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [0, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 } }, { store: s.store, top: 'auto' });
    const short = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [2, 0, 0], Width: 0.4, Depth: 0.4, Height: 2.5 } }, { store: s.store, top: 'auto' });
    const opted = addOrdinaryElementInStore(s.editor, anchor(s, s.l1), { kind: 'column', params: { Position: [4, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 } }, { store: s.store, top: { kind: 'fixed' } });
    const inventory = readStoreyInventory(s.store, s.view);
    expect(readTopAttachment(inventory, reaches)).toMatchObject({ targetStoreyId: s.l2, binding: 'relative' });
    expect(readTopAttachment(inventory, short)).toBeNull();
    expect(readTopAttachment(inventory, opted)).toBeNull();
  });
});
