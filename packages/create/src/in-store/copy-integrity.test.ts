/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9352: a copy never drops an element or silently mis-attaches one.
 *
 * - A door selected together with its wall travels with the wall's copy; the
 *   selection still gets one copy back for every element in it (F4 lost the
 *   hosted core door this way, one per floor).
 * - A single-product copy and its attachment re-bind are one write.
 * - `copyToStoreysInStore` reports the copies left unattached per storey.
 * - `auto` attaches a level beam whose top face meets the storey above.
 */

import { describe, expect, it } from 'vitest';
import * as create from '../index.js';
import { generateIfcGuid } from '@ifc-lite/encoding';
import { IfcCreator } from '../ifc-creator.js';
import { addOrdinaryElementInStore } from './ordinary-element.js';
import { addHostedElementInStore } from './hosted-element.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { parse, session, type Session } from './__test__/storey-fixtures.oracle.js';

const { readStoreyInventory, addStoreyInStore, writeTopAttachment, readTopAttachment } = create;

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

const anchor = (s: Session, storey: number) => (draft: import('@ifc-lite/mutations').StoreEditor) => resolveSpatialAnchor(s.store, storey, draft.getMutationView());
const wall = (s: Session, storey: number, y: number, Height = 3) =>
  addOrdinaryElementInStore(s.editor, anchor(s, storey), { kind: 'wall', params: { Start: [0, y, 0], End: [6, y, 0], Thickness: 0.2, Height } });

describe('a copy returns every selected element (#9352 P0)', () => {
  it('a door selected with its wall comes back as its own copy, on each target storey', async () => {
    const s = await levels();
    const host = wall(s, s.l1, 0);
    const door = addHostedElementInStore(s.store, s.editor, host, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } }).expressId;
    const other = wall(s, s.l1, 4);
    const selection = [host, door, other];
    const results = create.copyBatchInStore(s.store, s.editor, selection, [{ targetStoreyId: s.l2 }, { targetStoreyId: s.l3 }]);
    const perTransform = create.copiesOfSelection(selection, results, 2);
    expect(perTransform).toHaveLength(2);
    for (const [index, storey] of [s.l2, s.l3].entries()) {
      const copies = perTransform[index];
      // One copy per selected element, in the order selected.
      expect(copies.map((c) => c.sourceId)).toEqual(selection);
      const doorCopy = copies[1].copyId;
      expect(results.find((r) => r.copiedFrom.get(doorCopy) === door)?.fillingIds).toContain(doorCopy);
      // Every copy is contained in its target storey.
      const contained = containedIn(s, storey);
      for (const { copyId } of copies) expect(contained).toContain(copyId);
    }
  });

  it('refuses rather than drops a selected element that no copy carries', async () => {
    const s = await levels();
    const host = wall(s, s.l1, 0);
    const results = create.copyBatchInStore(s.store, s.editor, [host], [{ offset: [0, 3, 0] }]);
    expect(() => create.copiesOfSelection([host, 999_999], results, 1)).toThrow(/#999999 was not copied/);
  });

  it('copyToStoreysInStore returns the selection copies per storey', async () => {
    const s = await levels();
    const host = wall(s, s.l1, 0);
    const door = addHostedElementInStore(s.store, s.editor, host, { kind: 'door', params: { Offset: 1, Width: 0.9, Height: 2.1 } }).expressId;
    const copies = create.copyToStoreysInStore(s.store, s.editor, [host, door], [s.l2, s.l3]);
    for (const storey of copies) expect(storey.copies.map((c) => c.sourceId)).toEqual([host, door]);
  });
});

/** Products an IfcRelContainedInSpatialStructure places in `storey`. */
function containedIn(s: Session, storey: number): number[] {
  const out: number[] = [];
  const view = s.view;
  for (const record of view.getNewEntities()) {
    if (record.type.toUpperCase() !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE' || record.attributes[5] !== `#${storey}`) continue;
    for (const ref of record.attributes[4] as string[]) out.push(Number(String(ref).slice(1)));
  }
  return out;
}

describe('a single-product copy is one write (#9352)', () => {
  it('copyProductInStore outside a transaction leaves nothing behind when the re-bind refuses', async () => {
    const s = await levels();
    const source = wall(s, s.l1, 0);
    writeTopAttachment(s.view, source, s.guid(s.l2), 'explicit');
    const before = s.snapshot();
    const ctx = create.createCopyContext(s.store, s.editor);
    expect(() => create.copyProductInStore(ctx, source, { targetStoreyId: s.l2 })).toThrow(/attached to Level 2, which is not above its new storey Level 2/);
    expect(s.snapshot()).toEqual(before);
    // The context still copies afterwards.
    const copy = create.copyProductInStore(ctx, source, { offset: [0, 3, 0] });
    expect(s.view.getNewEntity(copy.copyId)).not.toBeNull();
  });
});

describe('copy notices travel with the result (#9352)', () => {
  it('copyToStoreysInStore lists each storey\'s unattached copies', async () => {
    // A column whose shape comes from the file is shared by its copies, so a copy needing a new height stays fixed.
    const creator = new IfcCreator({ Name: 'Shared' });
    const ground = creator.addIfcBuildingStorey({ Name: 'Level 1', Elevation: 0 });
    creator.addIfcBuildingStorey({ Name: 'Level 2', Elevation: 3 });
    creator.addIfcBuildingStorey({ Name: 'Level 3', Elevation: 7 });
    creator.addIfcColumn(ground, { Position: [0, 0, 0], Width: 0.4, Depth: 0.4, Height: 3 });
    const f = session(await parse(creator.toIfc().content));
    const storeys = readStoreyInventory(f.store, f.view).storeys.slice().sort((a, b) => a.elevation - b.elevation);
    const column = [...new AnchorEntityReader(f.store, f.view).ids('IFCCOLUMN')][0];
    writeTopAttachment(f.view, column, storeys[1].GlobalId, 'relative');
    const copies = create.copyToStoreysInStore(f.store, f.editor, [column], [storeys[1].expressId, storeys[2].expressId]);
    // Level 2 → Level 3 is 4 m, not 3 m: the copy on Level 2 needs a new height and cannot take it.
    expect(copies[0].unattachedTops).toEqual([{ copyId: copies[0].copies[0].copyId, reason: expect.stringMatching(/shares the source's shape/) }]);
    expect(copies[0].copies[0].unattachedTops).toEqual(copies[0].unattachedTops);
    expect(copies[1].unattachedTops).toEqual([]);
  });
});

describe('auto attaches a level beam by its top face (#9352)', () => {
  it('a level beam whose top face meets the storey above is attached; one that stops short stays fixed', async () => {
    const s = await levels();
    const beam = (z: number, y: number) => addOrdinaryElementInStore(s.editor, anchor(s, s.l1),
      { kind: 'beam', params: { Start: [0, y, z], End: [6, y, z], Width: 0.3, Height: 0.4 } }, { store: s.store, top: 'auto' });
    const touching = beam(2.8, 0), below = beam(2.5, 2);
    const inventory = readStoreyInventory(s.store, s.view);
    expect(readTopAttachment(inventory, touching)).toMatchObject({ targetStoreyId: s.l2, binding: 'relative' });
    expect(readTopAttachment(inventory, below)).toBeNull();
  });
});


it('#9407 selected assembly parts and nested assemblies retain carried unattached-top notices', async () => {
  const creator = new IfcCreator({ Name: 'Assembly' });
  const ground = creator.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  creator.addIfcBuildingStorey({ Name: 'Middle', Elevation: 3 });
  creator.addIfcBuildingStorey({ Name: 'Top', Elevation: 7 });
  creator.addIfcColumn(ground, { Position: [0,0,0], Width: .4, Depth: .4, Height: 3 });
  const f = session(await parse(creator.toIfc().content));
  const storeys = readStoreyInventory(f.store, f.view).storeys.slice().sort((a,b) => a.elevation-b.elevation);
  const reader = new AnchorEntityReader(f.store, f.view);
  const column = [...reader.ids('IFCCOLUMN')][0];
  const placement = reader.entity(column)!.attributes[5];
  if (typeof placement !== 'number' && typeof placement !== 'string') throw new Error('Column placement must be readable');
  const assembly = f.editor.addEntity('IfcElementAssembly', [generateIfcGuid(), null, 'Assembly', null, null, typeof placement === 'number' ? `#${placement}` : placement, null, null, null, null]).expressId;
  f.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${assembly}`, [`#${column}`]]);
  const outer = f.editor.addEntity('IfcElementAssembly', [generateIfcGuid(), null, 'Outer', null, null, typeof placement === 'number' ? `#${placement}` : placement, null, null, null, null]).expressId;
  f.editor.addEntity('IfcRelAggregates', [generateIfcGuid(), null, null, null, `#${outer}`, [`#${assembly}`]]);
  f.editor.addEntity('IfcRelContainedInSpatialStructure', [generateIfcGuid(), null, null, null, [`#${outer}`], `#${storeys[0].expressId}`]);
  writeTopAttachment(f.view, column, storeys[1].GlobalId, 'relative');
  const [copied] = create.copyToStoreysInStore(f.store, f.editor, [outer,assembly,column], [storeys[1].expressId]);
  const part = copied.copies[2];
  expect(copied.unattachedTops).toEqual([{copyId: part.copyId, reason: expect.stringMatching(/shares the source's shape/)}]);
  expect(part.unattachedTops).toEqual(copied.unattachedTops);
  expect(copied.copies[1].unattachedTops).toEqual(copied.unattachedTops);
});
