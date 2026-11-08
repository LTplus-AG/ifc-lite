/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Refreshing a LOADED element's base quantities from its edited geometry
 * (#9026 item 20 follow-up). Each element is authored, exported and parsed
 * again, so it reaches the session as a third party's would: with its own
 * `Qto_*BaseQuantities` in the file.
 */

import { describe, expect, it } from 'vitest';
import { QuantityType, type QuantitySet } from '@ifc-lite/data';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcCreator } from '../ifc-creator.js';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';
import {
  hasRefreshableBaseQuantities,
  refreshedBaseQuantitySetName,
  refreshedBaseQuantitySets,
  withRefreshedBaseQuantities,
} from './base-quantities-refresh.js';
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { setElementSizeInStore } from './element-size-edit.js';
import { addHostedElementInStore } from './hosted-element.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addSlabToStore } from './slab.js';
import { addWallToStore } from './wall.js';
import { readWallJoinTarget } from './wall-join-read.js';
import { parse } from './wall-join-mesh.oracle.js';

const WALL = 'Qto_WallBaseQuantities';

interface Session { store: IfcDataStore; view: MutablePropertyView; editor: StoreEditor; refresh: { on: boolean } }

/** The base the viewer's `configureMutationView` installs, with the setting as `refresh.on`. */
function install(view: MutablePropertyView, store: IfcDataStore, refresh: { on: boolean }): void {
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor((id, asking, occurrence) => {
    const own = extractQuantitiesOnDemand(store, id, asking);
    if (own.length === 0) return deriveAuthoredBaseQuantities(store, asking, occurrence);
    return refresh.on && id === occurrence ? withRefreshedBaseQuantities(store, asking, id, own) : own;
  });
  view.setQuantityBaseRevisions((asking) => (refresh.on ? refreshedBaseQuantitySets(store, asking) : []));
}

function open(store: IfcDataStore, on = true): Session {
  const view = new MutablePropertyView(null, 'm');
  const refresh = { on };
  install(view, store, refresh);
  return { store, view, editor: new StoreEditor(store, view), refresh };
}

const exportText = (s: Session): string =>
  new TextDecoder().decode(new StepExporter(s.store, s.view).export({ schema: 'IFC4', applyMutations: true }).content);

/** Author with `build` on a fresh storey, export, and parse the export: the result is a loaded file. */
async function loaded<T>(build: (s: Session, anchor: ReturnType<typeof resolveSpatialAnchor>) => T): Promise<{ file: string; ids: T }> {
  const creator = new IfcCreator({ Name: 'Refresh', Schema: 'IFC4' });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const authoring = open(await parse(creator.toIfc().content), false);
  const ids = build(authoring, resolveSpatialAnchor(authoring.store, storeyId, authoring.view));
  return { file: exportText(authoring), ids };
}

const values = (view: MutablePropertyView, id: number, set: string): Record<string, number> =>
  Object.fromEntries(view.getQuantitiesForEntity(id).find((q) => q.name === set)?.quantities.map((q) => [q.name, q.value]) ?? []);
async function fileValues(text: string, id: number, set: string): Promise<Record<string, number>> {
  const sets = extractQuantitiesOnDemand(await parse(text), id).filter((q) => q.name === set);
  expect(sets).toHaveLength(1);
  return Object.fromEntries(sets[0].quantities.map((q) => [q.name, q.value]));
}
const resizeWall = (s: Session, id: number, patch: { height?: number; thickness?: number }) =>
  expect(setElementSizeInStore({ dataStore: s.store, view: s.view, editor: s.editor }, id, { kind: 'wall', ...patch })).toMatchObject({ ok: true });

describe('a loaded wall', () => {
  it('unedited, reads the file\'s set with the setting on, and nothing is revised', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    expect(hasRefreshableBaseQuantities(s.store, s.view, wall)).toBe(true);
    expect(refreshedBaseQuantitySetName(s.store, s.view, wall)).toBeNull();
    expect(refreshedBaseQuantitySets(s.store, s.view)).toEqual([]);
    // The same file the setting off writes: nothing about it is rewritten.
    const body = (text: string) => text.slice(text.indexOf('DATA;'));
    const on = exportText(s);
    s.refresh.on = false;
    expect(body(on)).toBe(body(exportText(s)));
  });

  it('resized: on, its set follows the geometry, in the view and the export', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    resizeWall(s, wall, { height: 4, thickness: 0.3 });
    expect(values(s.view, wall, WALL)).toMatchObject({ Length: 8, Width: 0.3, Height: 4, GrossSideArea: 32, GrossVolume: 9.6 });
    expect(refreshedBaseQuantitySets(s.store, s.view)).toEqual([{ entityId: wall, setName: WALL }]);
    expect(await fileValues(exportText(s), wall, WALL)).toEqual(values(s.view, wall, WALL));
  });

  it('resized: off, its set and the export keep the file\'s values', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file), false);
    const before = values(s.view, wall, WALL);
    resizeWall(s, wall, { height: 4 });
    expect(values(s.view, wall, WALL)).toEqual(before);
    expect(await fileValues(exportText(s), wall, WALL)).toEqual(before);
  });

  it('keeps the file\'s value for a quantity the edit did not change, even where its tool measured it differently', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    // As a third party's file: its tool reports a Length the axis does not give (ArchiCAD stops it at the join).
    const thirdParty = file.replace("IFCQUANTITYLENGTH('Length',$,$,8.,$)", "IFCQUANTITYLENGTH('Length',$,$,7.6,$)");
    expect(thirdParty).not.toBe(file);
    const s = open(await parse(thirdParty));
    resizeWall(s, wall, { height: 4 });
    expect(values(s.view, wall, WALL)).toMatchObject({ Length: 7.6, Width: 0.2, Height: 4, GrossSideArea: 32, GrossVolume: 6.4 });
    expect(await fileValues(exportText(s), wall, WALL)).toEqual(values(s.view, wall, WALL));
  });

  it('subtracts the file\'s own door from the refreshed net values', async () => {
    const { file, ids: wall } = await loaded((s, a) => {
      const id = addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
      addHostedElementInStore(s.store, s.editor, id, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } });
      return id;
    });
    const s = open(await parse(file));
    expect(values(s.view, wall, WALL).NetVolume).toBe(4.4);
    resizeWall(s, wall, { height: 4 });
    // 8 x 0.2 x 4 less the 1 x 0.2 x 2 door the file voids the wall with.
    expect(values(s.view, wall, WALL)).toMatchObject({ GrossVolume: 6.4, NetVolume: 6, NetSideArea: 30 });
  });

  it('a door added this session refreshes the net values on its own', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    addHostedElementInStore(s.store, s.editor, wall, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } });
    expect(values(s.view, wall, WALL)).toMatchObject({ GrossVolume: 4.8, NetVolume: 4.4 });
    expect(refreshedBaseQuantitySets(s.store, s.view)).toEqual([{ entityId: wall, setName: WALL }]);
  });

  it('a file door re-pointed to another loaded wall moves its cut there, in the view and the export', async () => {
    const { file, ids } = await loaded((s, a) => {
      const first = addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
      const second = addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
      addHostedElementInStore(s.store, s.editor, first, { kind: 'door', params: { Offset: 2, Width: 1, Height: 2 } });
      return { first, second };
    });
    const s = open(await parse(file));
    const rel = [...(s.store.entityIndex.byType.get('IFCRELVOIDSELEMENT') ?? [])][0];
    expect(rel).toBeDefined();
    // The two walls coincide, so the door's box cuts the second exactly as it cut the first.
    s.editor.setPositionalAttribute(rel, 4, `#${ids.second}`);
    expect(values(s.view, ids.first, WALL)).toMatchObject({ NetVolume: 4.8 });
    expect(values(s.view, ids.second, WALL)).toMatchObject({ NetVolume: 4.4 });
    expect(refreshedBaseQuantitySets(s.store, s.view).map((r) => r.entityId).sort()).toEqual([ids.first, ids.second].sort());
    expect(await fileValues(exportText(s), ids.second, WALL)).toEqual(values(s.view, ids.second, WALL));
  });

  it('an edit that leaves the shape alone refreshes nothing', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    s.view.setAttribute(wall, 'Name', 'Renamed');
    expect(refreshedBaseQuantitySetName(s.store, s.view, wall)).toBeNull();
    expect(refreshedBaseQuantitySets(s.store, s.view)).toEqual([]);
  });

  it('moving it far from the origin refreshes nothing, though the derivation reads placed points', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    const read = readWallJoinTarget(s.store, s.view, wall, 1);
    expect(read).not.toBeNull();
    // A georeferenced storey-local position: the last digits of a placed length move with it.
    s.editor.setPositionalAttribute(read!.locationPointId, 0, [2_600_123.123, 1_200_456.789, 0]);
    expect(refreshedBaseQuantitySetName(s.store, s.view, wall)).toBeNull();
    expect(refreshedBaseQuantitySets(s.store, s.view)).toEqual([]);
  });

  it('a person\'s edit of a quantity and deletion of the set win over the refresh', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    resizeWall(s, wall, { height: 4 });
    s.view.setQuantity(wall, WALL, 'Height', 9, QuantityType.Length);
    expect(values(s.view, wall, WALL)).toMatchObject({ Height: 9, GrossVolume: 6.4 });
    expect((await fileValues(exportText(s), wall, WALL)).Height).toBe(9);
    s.view.deleteQuantitySet(wall, WALL);
    expect(s.view.getQuantitiesForEntity(wall).some((q) => q.name === WALL)).toBe(false);
    expect(extractQuantitiesOnDemand(await parse(exportText(s)), wall).some((q) => q.name === WALL)).toBe(false);
  });
});

describe('the other kinds', () => {
  it('a loaded slab, column and beam refresh from a size edit', async () => {
    const { file, ids } = await loaded((s, a) => ({
      slab: addSlabToStore(s.editor, a, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 }).slabId,
      column: addColumnToStore(s.editor, a, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }).columnId,
      beam: addBeamToStore(s.editor, a, { Start: [0, 3, 3], End: [8, 3, 3], Width: 0.2, Height: 0.3 }).beamId,
    }));
    const s = open(await parse(file));
    const target = { dataStore: s.store, view: s.view, editor: s.editor };
    expect(setElementSizeInStore(target, ids.slab, { kind: 'slab', thickness: 0.3 })).toMatchObject({ ok: true });
    expect(setElementSizeInStore(target, ids.column, { kind: 'linear', width: 0.5, cross: 0.4 })).toMatchObject({ ok: true });
    expect(setElementSizeInStore(target, ids.beam, { kind: 'linear', width: 0.2, cross: 0.5 })).toMatchObject({ ok: true });
    expect(values(s.view, ids.slab, 'Qto_SlabBaseQuantities')).toMatchObject({ Width: 0.3, GrossVolume: 14.4 });
    expect(values(s.view, ids.column, 'Qto_ColumnBaseQuantities')).toMatchObject({ CrossSectionArea: 0.2, GrossVolume: 0.6 });
    expect(values(s.view, ids.beam, 'Qto_BeamBaseQuantities')).toMatchObject({ CrossSectionArea: 0.1, GrossVolume: 0.8 });
    const text = exportText(s);
    expect(await fileValues(text, ids.slab, 'Qto_SlabBaseQuantities')).toEqual(values(s.view, ids.slab, 'Qto_SlabBaseQuantities'));
    expect(await fileValues(text, ids.column, 'Qto_ColumnBaseQuantities')).toEqual(values(s.view, ids.column, 'Qto_ColumnBaseQuantities'));
    expect(await fileValues(text, ids.beam, 'Qto_BeamBaseQuantities')).toEqual(values(s.view, ids.beam, 'Qto_BeamBaseQuantities'));
  });
});

describe('what a refresh replaces', () => {
  it('an IFC2X3-style BaseQuantities set keeps its name; an element with no base set gains none', async () => {
    const { file, ids: wall } = await loaded((s, a) => addWallToStore(s.editor, a, { Start: [0, 0, 0], End: [8, 0, 0], Thickness: 0.2, Height: 3 }).wallId);
    const s = open(await parse(file));
    resizeWall(s, wall, { height: 4 });
    const legacy: QuantitySet[] = [{ name: 'BaseQuantities', quantities: [{ name: 'Height', type: QuantityType.Length, value: 3 }] }];
    expect(withRefreshedBaseQuantities(s.store, s.view, wall, legacy)).toMatchObject([{ name: 'BaseQuantities', quantities: expect.arrayContaining([{ name: 'Height', type: QuantityType.Length, value: 4 }]) }]);
    // A second set of the same name is a different set: only the first is refreshed.
    const twin: QuantitySet = { name: 'BaseQuantities', quantities: [{ name: 'Fixings', type: QuantityType.Count, value: 2 }] };
    const pair = withRefreshedBaseQuantities(s.store, s.view, wall, [...legacy, twin]);
    expect(pair[1]).toBe(twin);
    expect(pair[0]).not.toBe(legacy[0]);
    const other: QuantitySet[] = [{ name: 'Qto_Custom', quantities: [{ name: 'Fixings', type: QuantityType.Count, value: 4 }] }];
    expect(withRefreshedBaseQuantities(s.store, s.view, wall, other)).toBe(other);
  });
});
