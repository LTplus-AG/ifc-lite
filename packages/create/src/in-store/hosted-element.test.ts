/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: the real Bonsai sample has source wall openings. The shared
 * operation must protect both those and cuts created through the overlay. */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addHostedElementInStore, readHostOpeningExtents } from './hosted-element.js';
import { addWallToStore } from './wall.js';
import { AnchorEntityReader, resolveSpatialAnchor } from './resolve-anchor.js';
import { IfcCreator } from '../ifc-creator.js';

const WALL = 1222;
async function session() {
  const source = await readFile(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, view, editor: new StoreEditor(store, view) };
}
const DOOR = { kind: 'door', params: { Offset: 8, Width: 0.9, Height: 2.1 } } as const;

describe('#6232 D5 shared hosted placement', () => {
  for (const Schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`writes ${Schema} hosted records and checks millimetre dimensions in metres`, async () => {
      const creator = new IfcCreator({ Schema, LengthUnit: 'MILLIMETRE' });
      const storey = creator.addIfcBuildingStorey({ Name: 'Level 0', Elevation: 0 });
      const store = await new IfcParser().parseColumnar(new TextEncoder().encode(creator.toIfc().content).buffer, { disableWorkerScan: true });
      const view = new MutablePropertyView(null, 'm');
      const editor = new StoreEditor(store, view);
      const wall = addWallToStore(editor, resolveSpatialAnchor(store, storey, view), { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
      const door = addHostedElementInStore(store, editor, wall, { kind: 'door', params: { Offset: 2, Width: 0.9, Height: 2.1 } });
      const record = view.getNewEntity(door.expressId)!;
      expect(record.attributes).toHaveLength(Schema === 'IFC2X3' ? 10 : 13);
      expect(record.attributes[8]).toBeCloseTo(2100, 9);
      expect(record.attributes[9]).toBeCloseTo(900, 9);
      expect(view.getNewEntity(door.openingId)!.attributes).toHaveLength(Schema === 'IFC2X3' ? 8 : 9);
      const cut = readHostOpeningExtents(store, wall, view).cuts[0];
      expect(cut.bounds.min[0]).toBeCloseTo(1550, 9);
      const before = view.getNewEntities().length;
      expect(() => addHostedElementInStore(store, editor, wall, { kind: 'opening', params: { Offset: 2, Width: 0.9, Height: 2.1 } })).toThrow(/overlaps opening/);
      expect(view.getNewEntities()).toHaveLength(before);
    });
  }

  it('refuses overlap with a real source opening before writing any graph', async () => {
    const { store, view, editor } = await session();
    const { cuts, unreadable } = readHostOpeningExtents(store, WALL, view);
    expect(unreadable).toEqual([]);
    expect(cuts.length).toBeGreaterThan(0);
    const { bounds } = cuts[0];
    expect(() => addHostedElementInStore(store, editor, WALL, { kind: 'opening', params: {
      Offset: (bounds.min[0] + bounds.max[0]) / 2,
      Sill: bounds.min[2], Width: bounds.max[0] - bounds.min[0], Height: bounds.max[2] - bounds.min[2],
    } })).toThrow(/overlaps opening/);
    expect(view.getMutations()).toEqual([]);
    expect(view.getNewEntities()).toEqual([]);
  });

  it('observes overlay cuts, permits edge-touch and vertically separate openings', async () => {
    const { store, view, editor } = await session();
    const door = addHostedElementInStore(store, editor, WALL, DOOR);
    const before = view.getNewEntities().length;
    expect(() => addHostedElementInStore(store, editor, WALL, DOOR)).toThrow(/overlaps opening/);
    expect(view.getNewEntities()).toHaveLength(before);
    const above = addHostedElementInStore(store, editor, WALL, {
      kind: 'window', params: { Offset: 8, Sill: 2.1, Width: 0.9, Height: 0.9 },
    });
    const side = addHostedElementInStore(store, editor, WALL, {
      kind: 'opening', params: { Offset: 8.95, Sill: 0, Width: 1, Height: 2 },
    });
    const cuts = readHostOpeningExtents(store, WALL, view).cuts;
    expect(cuts.find(c => c.openingId === door.openingId)?.fillingId).toBe(door.expressId);
    expect(cuts.find(c => c.openingId === above.openingId)?.fillingId).toBe(above.expressId);
    expect(cuts.some(c => c.openingId === side.openingId)).toBe(true);
  });

  it('reads overlay hosts and rolls back helpers when a late GlobalId refusal throws', async () => {
    const { store, view, editor } = await session();
    const wall = addWallToStore(editor, resolveSpatialAnchor(store, 42, view), {
      Start: [0, 5, 0], End: [4, 5, 0], Thickness: 0.2, Height: 3,
    });
    const before = view.getNewEntities();
    expect(() => addHostedElementInStore(store, editor, wall.wallId, {
      kind: 'door', params: { Offset: 1, Width: 1, Height: 2, GlobalId: 'invalid' },
    })).toThrow(/GlobalId/);
    expect(view.getNewEntities()).toEqual(before);
    const placed = addHostedElementInStore(store, editor, wall.wallId, { kind: 'door', params: { Offset: 1, Width: 1, Height: 2 } });
    expect(readHostOpeningExtents(store, wall.wallId, view).cuts[0].openingId).toBe(placed.openingId);
  });

  it('reports missing opening references and unsupported placement frames rather than skipping them', async () => {
    const { store, view, editor } = await session();
    const reader = new AnchorEntityReader(store, view);
    const rel = [...reader.ids('IFCRELVOIDSELEMENT')].find(id => reader.entity(id)?.attributes[4] === WALL);
    expect(rel).toBeDefined();
    if (rel === undefined) throw new Error('The Bonsai fixture must contain a source wall void');
    editor.setPositionalAttribute(rel, 5, '#999999');
    expect(readHostOpeningExtents(store, WALL, view).unreadable).toContain(999999);
    expect(() => addHostedElementInStore(store, editor, WALL, DOOR)).toThrow(/cannot be read/);
    const created = view.getNewEntities();
    expect(created).toEqual([]);
  });

  it('refuses outside dimensions and unsupported schemas without mutation', async () => {
    const { store, view, editor } = await session();
    expect(() => addHostedElementInStore(store, editor, WALL, { kind: 'door', params: { ...DOOR.params, Offset: 10 } })).toThrow(/doesn't fit/);
    store.schemaVersion = 'IFC5';
    expect(() => addHostedElementInStore(store, editor, WALL, DOOR)).toThrow(/IFC5 is refused/);
    expect(view.getMutations()).toEqual([]);
    expect(view.getNewEntities()).toEqual([]);
  });

  it('refuses a void with an unreadable host rather than assuming it belongs elsewhere', async () => {
    const { store, view, editor } = await session();
    const reader = new AnchorEntityReader(store, view);
    const rel = [...reader.ids('IFCRELVOIDSELEMENT')][0];
    expect(rel).toBeDefined();
    editor.setPositionalAttribute(rel, 4, '$');
    expect(readHostOpeningExtents(store, WALL, view).unreadable).toContain(rel);
    const before = view.getMutations();
    expect(() => addHostedElementInStore(store, editor, WALL, DOOR)).toThrow(/cannot be read/);
    expect(view.getMutations()).toEqual(before);
    expect(view.getNewEntities()).toEqual([]);
  });
});
