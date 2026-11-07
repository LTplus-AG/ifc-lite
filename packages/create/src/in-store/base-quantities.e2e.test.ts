/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Authored base quantities (#9026 item 20), through the parts a user reaches:
 * author on a parsed storey through the overlay, edit, read the view, export
 * with `StepExporter`, re-parse, and read the file's own quantity sets.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';
import { addBeamToStore } from './beam.js';
import { addColumnToStore } from './column.js';
import { setElementSizeInStore } from './element-size-edit.js';
import { splitElementInStore } from './element-split.js';
import { addHostedElementInStore } from './hosted-element.js';
import { addOpeningToStore } from './opening.js';
import { resolveHostAnchor } from './resolve-host.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addRoofToStore } from './roof.js';
import { addSlabToStore } from './slab.js';
import { addWallToStore } from './wall.js';
import { applyWallJoinToStore, wallJoinTargetFromBuild } from './wall-join-apply.js';
import { parse } from './wall-join-mesh.oracle.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));

type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

interface Session {
  store: IfcDataStore;
  view: MutablePropertyView;
  editor: StoreEditor;
  storeyId: number;
  anchor: ReturnType<typeof resolveSpatialAnchor>;
}

/** The base the viewer's `configureMutationView` installs. */
function install(view: MutablePropertyView, store: IfcDataStore): void {
  view.setOnDemandExtractor((id) => extractPropertiesOnDemand(store, id));
  view.setQuantityExtractor((id, asking, occurrence) => {
    const own = extractQuantitiesOnDemand(store, id);
    return own.length > 0 ? own : deriveAuthoredBaseQuantities(store, asking, occurrence);
  });
}

async function session(schema: Schema = 'IFC4', rewrite: (text: string) => string = (text) => text): Promise<Session> {
  const creator = new IfcCreator({ Name: 'Quantities', Schema: schema });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const store = await parse(rewrite(creator.toIfc().content));
  const view = new MutablePropertyView(null, 'm');
  install(view, store);
  const editor = new StoreEditor(store, view);
  return { store, view, editor, storeyId, anchor: resolveSpatialAnchor(store, storeyId, view) };
}

const values = (view: MutablePropertyView, id: number, set: string): Record<string, number> =>
  Object.fromEntries(view.getQuantitiesForEntity(id).find((s) => s.name === set)?.quantities.map((q) => [q.name, q.value]) ?? []);

function exportText(s: Session, schema: Schema = 'IFC4'): string {
  return new TextDecoder().decode(new StepExporter(s.store, s.view).export({ schema, applyMutations: true }).content);
}

/** The sets the exported file carries for `id`, as the parser reads a third party's. */
function fileQuantities(store: IfcDataStore, id: number, set: string): Record<string, number> {
  return Object.fromEntries(extractQuantitiesOnDemand(store, id).find((s) => s.name === set)?.quantities.map((q) => [q.name, q.value]) ?? []);
}

const wallAt = (s: Session) => addWallToStore(s.editor, s.anchor, { Start: [1, 2, 0], End: [6, 2, 0], Thickness: 0.2, Height: 3 });
const WALL_QTO = 'Qto_WallBaseQuantities';

describe('deriveAuthoredBaseQuantities', () => {
  it('reads each authored kind off its geometry', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [2, 3, 0], Width: 8, Depth: 6, Thickness: 0.25 }).slabId;
    const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 3], Width: 8, Depth: 6, Thickness: 0.25 }).roofId;
    const column = addColumnToStore(s.editor, s.anchor, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }).columnId;
    const beam = addBeamToStore(s.editor, s.anchor, { Start: [0, 3, 3], End: [4, 3, 3], Width: 0.2, Height: 0.3 }).beamId;

    expect(values(s.view, wall, WALL_QTO)).toEqual({
      Length: 5, Width: 0.2, Height: 3,
      GrossFootprintArea: 1, NetFootprintArea: 1,
      GrossSideArea: 15, NetSideArea: 15,
      GrossVolume: 3, NetVolume: 3,
    });
    expect(values(s.view, slab, 'Qto_SlabBaseQuantities')).toEqual({
      Width: 0.25, Length: 8, Depth: 6, Perimeter: 28,
      GrossArea: 48, NetArea: 48, GrossVolume: 12, NetVolume: 12,
    });
    expect(values(s.view, roof, 'Qto_RoofBaseQuantities')).toEqual({ GrossArea: 48, NetArea: 48, ProjectedArea: 48 });
    expect(values(s.view, column, 'Qto_ColumnBaseQuantities')).toEqual({
      Length: 3, CrossSectionArea: 0.12, OuterSurfaceArea: 4.2, GrossSurfaceArea: 4.44, NetSurfaceArea: 4.44, GrossVolume: 0.36, NetVolume: 0.36,
    });
    expect(values(s.view, beam, 'Qto_BeamBaseQuantities')).toEqual({
      Length: 4, CrossSectionArea: 0.06, OuterSurfaceArea: 4, GrossSurfaceArea: 4.12, NetSurfaceArea: 4.12, GrossVolume: 0.24, NetVolume: 0.24,
    });
  });

  it('a polygon slab reads its shoelace area and a section beam its section', async () => {
    const s = await session();
    const slab = addSlabToStore(s.editor, s.anchor, { Profile: 'polygon', Thickness: 0.2, OuterCurve: [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]] }).slabId;
    const set = values(s.view, slab, 'Qto_SlabBaseQuantities');
    expect(set).toMatchObject({ GrossArea: 12, Perimeter: 16, GrossVolume: 2.4, Width: 0.2 });
    // The schema gives Length and Depth only for a rectangle.
    expect(set.Length).toBeUndefined();
    const beam = addBeamToStore(s.editor, s.anchor, {
      Start: [0, 0, 3], End: [2, 0, 3],
      Profile: { Type: 'I', OverallWidth: 0.2, OverallDepth: 0.3, WebThickness: 0.01, FlangeThickness: 0.02 },
    }).beamId;
    expect(values(s.view, beam, 'Qto_BeamBaseQuantities')).toMatchObject({ Length: 2, CrossSectionArea: 0.0106, GrossVolume: 0.0212 });
  });

  it('follows a resize on the next read', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    expect(setElementSizeInStore({ dataStore: s.store, view: s.view, editor: s.editor }, wall, { kind: 'wall', height: 4, thickness: 0.3 })).toMatchObject({ ok: true });
    expect(values(s.view, wall, WALL_QTO)).toMatchObject({ Height: 4, Width: 0.3, GrossSideArea: 20, GrossVolume: 6, NetVolume: 6 });
  });

  it('reads a draft edit in the draft and the published state after', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    expect(() => s.editor.runAtomic((draft) => {
      const view = draft.getMutationView();
      setElementSizeInStore({ dataStore: s.store, view, editor: draft }, wall, { kind: 'wall', height: 5 });
      expect(values(view, wall, WALL_QTO).Height).toBe(5);
      throw new Error('refused');
    })).toThrow('refused');
    expect(values(s.view, wall, WALL_QTO).Height).toBe(3);
  });

  it("subtracts a door and a window from a wall's net values, and leaves its gross", async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    addHostedElementInStore(s.store, s.editor, wall, { kind: 'door', params: { Offset: 1.5, Width: 1, Height: 2 } });
    const withDoor = values(s.view, wall, WALL_QTO);
    expect(withDoor).toMatchObject({ GrossSideArea: 15, NetSideArea: 13, GrossVolume: 3, NetVolume: 2.6, GrossFootprintArea: 1, NetFootprintArea: 0.8 });
    addHostedElementInStore(s.store, s.editor, wall, { kind: 'window', params: { Offset: 3.5, Width: 1, Height: 1, Sill: 1 } });
    // The window does not reach the floor, so the footprint keeps what the door left.
    expect(values(s.view, wall, WALL_QTO)).toMatchObject({ NetSideArea: 12, NetVolume: 2.4, NetFootprintArea: 0.8 });
  });

  it('an opening moved clear of its host cuts nothing', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    const opening = addOpeningToStore(s.editor, resolveHostAnchor(s.store, wall, s.view), { Offset: 1.5, Width: 1, Height: 2 });
    expect(values(s.view, wall, WALL_QTO).NetSideArea).toBe(13);
    // Slide it 2 m sideways out of the wall's thickness: still over the wall in X and Z.
    const placement = s.view.getNewEntity(opening.placementId)!.attributes[1] as string;
    const point = s.view.getNewEntity(Number(placement.slice(1)))!.attributes[0] as string;
    const at = s.view.getNewEntity(Number(point.slice(1)))!.attributes[0] as number[];
    s.view.setPositionalAttribute(Number(point.slice(1)), 0, [at[0], at[1] + 2, at[2]]);
    expect(values(s.view, wall, WALL_QTO)).toMatchObject({ NetSideArea: 15, NetVolume: 3, NetFootprintArea: 1 });

    const slab = addSlabToStore(s.editor, s.anchor, { Position: [0, 10, 0], Width: 8, Depth: 6, Thickness: 0.25 }).slabId;
    const hole = addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab, s.view), { Position: [4, 3], Width: 2, Depth: 1 });
    const holePlacement = s.view.getNewEntity(hole.placementId)!.attributes[1] as string;
    const holePoint = Number((s.view.getNewEntity(Number(holePlacement.slice(1)))!.attributes[0] as string).slice(1));
    const holeAt = s.view.getNewEntity(holePoint)!.attributes[0] as number[];
    s.view.setPositionalAttribute(holePoint, 0, [holeAt[0], holeAt[1], holeAt[2] + 5]);
    expect(values(s.view, slab, 'Qto_SlabBaseQuantities')).toMatchObject({ NetArea: 48, NetVolume: 12 });
  });

  it('subtracts a slab opening, clipped to the outline', async () => {
    const s = await session();
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [2, 3, 0], Width: 8, Depth: 6, Thickness: 0.25 });
    const host = resolveHostAnchor(s.store, slab.slabId, s.view);
    // 2 x 1 inside the slab, then one hanging half off its corner.
    addOpeningToStore(s.editor, host, { Position: [4, 3], Width: 2, Depth: 1 });
    expect(values(s.view, slab.slabId, 'Qto_SlabBaseQuantities')).toMatchObject({ GrossArea: 48, NetArea: 46, GrossVolume: 12, NetVolume: 11.5 });
    addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab.slabId, s.view), { Position: [8, 6], Width: 2, Depth: 2 });
    expect(values(s.view, slab.slabId, 'Qto_SlabBaseQuantities').NetArea).toBe(45);
  });

  it('a void through a column lowers its net volume and leaves out the net surface it cannot know', async () => {
    const s = await session();
    const wall = addWallToStore(s.editor, s.anchor, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 }).wallId;
    const opening = addOpeningToStore(s.editor, resolveHostAnchor(s.store, wall, s.view), { Offset: 0, Sill: 1, Width: 1, Height: 1 });
    const column = addColumnToStore(s.editor, s.anchor, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }).columnId;
    s.view.setPositionalAttribute(opening.relVoidsId, 4, `#${column}`);
    const set = values(s.view, column, 'Qto_ColumnBaseQuantities');
    // 0.3 wide, the 0.3 deep cut, 1 high, out of 0.3 x 0.4 x 3.
    expect(set.NetVolume).toBeCloseTo(0.27, 9);
    expect(set.GrossVolume).toBe(0.36);
    expect(set.NetSurfaceArea).toBeUndefined();
  });

  it('starts over when the view is rebound to another store', async () => {
    const metres = await session();
    const wall = wallAt(metres).wallId;
    const sideArea = (store: IfcDataStore) => deriveAuthoredBaseQuantities(store, metres.view, wall)[0].quantities.find((q) => q.name === 'GrossSideArea')?.value;
    expect(sideArea(metres.store)).toBe(15);
    const mm = await session('IFC4', (text) => text.replace(/IFCSIUNIT\(\*,\.LENGTHUNIT\.,\$,\.METRE\.\)/, 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'));
    // The same overlay read against a millimetre store, with no write in between.
    expect(sideArea(mm.store)).toBeCloseTo(1.5e-5, 12);
  });

  it('a slab turned in plan keeps its quantities and clips its opening in its own axes', async () => {
    const s = await session();
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [2, 3, 0], Width: 8, Depth: 6, Thickness: 0.25 });
    // Turn the slab's placement a quarter turn: its X now runs along the storey's Y.
    const placement = s.view.getNewEntity(slab.placementId)!.attributes[1] as string;
    const axes = s.view.getNewEntity(Number(placement.slice(1)))!;
    const turned = s.editor.addEntity('IfcDirection', [[0, 1, 0]]).expressId;
    const up = s.editor.addEntity('IfcDirection', [[0, 0, 1]]).expressId;
    s.view.setPositionalAttribute(Number(placement.slice(1)), 1, `#${up}`);
    s.view.setPositionalAttribute(Number(placement.slice(1)), 2, `#${turned}`);
    expect(axes.type.toUpperCase()).toBe('IFCAXIS2PLACEMENT3D');
    // 2 x 1 inside, then 2 x 2 hanging half off the slab's own +X/+Y corner.
    addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab.slabId, s.view), { Position: [4, 3], Width: 2, Depth: 1 });
    addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab.slabId, s.view), { Position: [8, 6], Width: 2, Depth: 2 });
    expect(values(s.view, slab.slabId, 'Qto_SlabBaseQuantities')).toMatchObject({ GrossArea: 48, NetArea: 45, NetVolume: 11.25 });
  });

  it('a tilted slab reads none rather than a plan area it does not have', async () => {
    const s = await session();
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 });
    const placement = Number((s.view.getNewEntity(slab.placementId)!.attributes[1] as string).slice(1));
    const tilted = s.editor.addEntity('IfcDirection', [[0, 0.6, 0.8]]).expressId;
    s.view.setPositionalAttribute(placement, 1, `#${tilted}`);
    expect(values(s.view, slab.slabId, 'Qto_SlabBaseQuantities')).toEqual({});
  });

  it('a blind opening takes only the depth it reaches from a slab\'s net volume', async () => {
    const s = await session();
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 }).slabId;
    const opening = addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab, s.view), { Position: [4, 3], Width: 2, Depth: 1 });
    // The builder cuts from 50 mm below the body; a 0.15 m depth stops 0.1 m into it.
    s.view.setPositionalAttribute(opening.solidId, 3, 0.15);
    expect(values(s.view, slab, 'Qto_SlabBaseQuantities')).toMatchObject({ GrossVolume: 12, NetArea: 46, NetVolume: 11.8 });
  });

  it('reads both pieces of a split, for each way of splitting', async () => {
    const s = await session();
    const wall = splitElementInStore(s.store, s.editor, wallAt(s).wallId, { kind: 'wall', distance: 2 });
    expect([wall.leftId, wall.rightId].map((id) => values(s.view, id, WALL_QTO).Length).sort()).toEqual([2, 3]);
    const beamId = addBeamToStore(s.editor, s.anchor, { Start: [0, 3, 3], End: [4, 3, 3], Width: 0.2, Height: 0.3 }).beamId;
    const beam = splitElementInStore(s.store, s.editor, beamId, { kind: 'linear', distance: 1 });
    expect([beam.leftId, beam.rightId].map((id) => values(s.view, id, 'Qto_BeamBaseQuantities').Length).sort()).toEqual([1, 3]);
    const slabId = addSlabToStore(s.editor, s.anchor, { Position: [0, 10, 0], Width: 4, Depth: 2, Thickness: 0.2 }).slabId;
    const slab = splitElementInStore(s.store, s.editor, slabId, { kind: 'slab', a: [1, 9], b: [1, 13] });
    expect([slab.leftId, slab.rightId].map((id) => values(s.view, id, 'Qto_SlabBaseQuantities').GrossArea).sort()).toEqual([2, 6]);
  });

  it('a copy of an authored wall reads its own shape, even with the source resized', async () => {
    const s = await session();
    const source = wallAt(s).wallId;
    const copy = addWallToStore(s.editor, s.anchor, { Start: [1, 4, 0], End: [3, 4, 0], Thickness: 0.2, Height: 3 }).wallId;
    s.view.setEntityAlias(copy, source);
    expect(values(s.view, copy, WALL_QTO).Length).toBe(2);
    setElementSizeInStore({ dataStore: s.store, view: s.view, editor: s.editor }, source, { kind: 'wall', height: 5 });
    expect(values(s.view, copy, WALL_QTO).Height).toBe(3);
    expect(fileQuantities(await parse(exportText(s)), copy, WALL_QTO).Length).toBe(2);
  });

  it('reads a joined wall\'s trimmed body, not the rectangle it was drawn as', async () => {
    const s = await session();
    const aParams = { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: 3 } satisfies Parameters<typeof addWallToStore>[2];
    const bParams = { Start: [4, -3, 0], End: [4, 3, 0], Thickness: 0.2, Height: 3 } satisfies Parameters<typeof addWallToStore>[2];
    const a = addWallToStore(s.editor, s.anchor, aParams);
    const b = addWallToStore(s.editor, s.anchor, bParams);
    const before = values(s.view, a.wallId, WALL_QTO).GrossFootprintArea;
    applyWallJoinToStore(s.editor, s.anchor, wallJoinTargetFromBuild(a, aParams), wallJoinTargetFromBuild(b, bParams), {});
    const after = values(s.view, a.wallId, WALL_QTO);
    // A T: the abutting wall stops at the face of the one it meets, 0.1 m short of its axis.
    expect(before).toBe(0.8);
    expect(after.GrossFootprintArea).toBeCloseTo(0.78, 9);
    expect(after.GrossVolume).toBeCloseTo(2.34, 9);
    expect(values(s.view, b.wallId, WALL_QTO).GrossFootprintArea).toBeCloseTo(1.2, 9);
  });

  it('answers for the class a retype gave the element', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    s.view.setEntityType(wall, 'IFCWALLSTANDARDCASE');
    expect(values(s.view, wall, WALL_QTO).Length).toBe(5);
  });

  it('leaves other authored kinds and every loaded element alone', async () => {
    const s = await session();
    const space = s.editor.addEntity('IfcBuildingElementProxy', []).expressId;
    expect(deriveAuthoredBaseQuantities(s.store, s.view, space)).toEqual([]);
    const loaded = s.anchor.storeyId;
    expect(deriveAuthoredBaseQuantities(s.store, s.view, loaded)).toEqual([]);
  });

  it('applies a person\'s edit over a derived value, and keeps a deleted set deleted', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    s.view.setQuantity(wall, WALL_QTO, 'NetVolume', 2.5);
    expect(values(s.view, wall, WALL_QTO)).toMatchObject({ NetVolume: 2.5, GrossVolume: 3 });
    setElementSizeInStore({ dataStore: s.store, view: s.view, editor: s.editor }, wall, { kind: 'wall', height: 4 });
    expect(values(s.view, wall, WALL_QTO)).toMatchObject({ NetVolume: 2.5, GrossVolume: 4 });
    s.view.deleteQuantitySet(wall, WALL_QTO);
    expect(s.view.getQuantitiesForEntity(wall)).toEqual([]);
    expect(exportText(s)).not.toContain(WALL_QTO);
  });
});

describe('the export carries what the view shows', () => {
  for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3'] as const) {
    it(`round-trips every kind through an ${schema} file`, async () => {
      const s = await session(schema);
      const ids = {
        Qto_WallBaseQuantities: wallAt(s).wallId,
        Qto_SlabBaseQuantities: addSlabToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 }).slabId,
        Qto_RoofBaseQuantities: addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 3], Width: 8, Depth: 6, Thickness: 0.25 }).roofId,
        Qto_ColumnBaseQuantities: addColumnToStore(s.editor, s.anchor, { Position: [1, 1, 0], Width: 0.3, Depth: 0.4, Height: 3 }).columnId,
        Qto_BeamBaseQuantities: addBeamToStore(s.editor, s.anchor, { Start: [0, 3, 3], End: [4, 3, 3], Width: 0.2, Height: 0.3 }).beamId,
      };
      addHostedElementInStore(s.store, s.editor, ids.Qto_WallBaseQuantities, { kind: 'door', params: { Offset: 1.5, Width: 1, Height: 2 } });
      const reopened = await parse(exportText(s, schema));
      for (const [set, id] of Object.entries(ids)) {
        expect(fileQuantities(reopened, id, set), set).toEqual(values(s.view, id, set));
      }
    });
  }

  it('writes the edited shape, not the shape it was authored with', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    setElementSizeInStore({ dataStore: s.store, view: s.view, editor: s.editor }, wall, { kind: 'wall', height: 4 });
    expect(fileQuantities(await parse(exportText(s)), wall, WALL_QTO)).toMatchObject({ Height: 4, GrossSideArea: 20 });
  });

  it('honours includeQuantities: false', async () => {
    const s = await session();
    wallAt(s);
    const { content } = new StepExporter(s.store, s.view).export({ schema: 'IFC4', applyMutations: true, includeQuantities: false });
    expect(new TextDecoder().decode(content)).not.toContain(WALL_QTO);
  });

  it('uses the schema\'s own quantity names', async () => {
    const ifc4x3 = await session('IFC4X3');
    const wall = wallAt(ifc4x3).wallId;
    const set = fileQuantities(await parse(exportText(ifc4x3, 'IFC4X3')), wall, WALL_QTO);
    expect(set).toMatchObject({ GrossFootPrintArea: 1, NetFootPrintArea: 1 });
    expect(set.GrossFootprintArea).toBeUndefined();
  });

  it('writes lengths in the file\'s unit and areas and volumes in their declared ones', async () => {
    // A millimetre file that keeps m2 and m3, as Revit writes them.
    const mm = await session('IFC4', (text) => text.replace(/IFCSIUNIT\(\*,\.LENGTHUNIT\.,\$,\.METRE\.\)/, 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'));
    const wall = wallAt(mm).wallId;
    const set = values(mm.view, wall, WALL_QTO);
    expect(set).toMatchObject({ Length: 5000, Width: 200, Height: 3000, GrossSideArea: 15, GrossVolume: 3 });
    addHostedElementInStore(mm.store, mm.editor, wall, { kind: 'door', params: { Offset: 1.5, Width: 1, Height: 2 } });
    expect(values(mm.view, wall, WALL_QTO)).toMatchObject({ NetSideArea: 13, NetVolume: 2.6, NetFootprintArea: 0.8 });
    const slab = addSlabToStore(mm.editor, mm.anchor, { Position: [2, 3, 0], Width: 8, Depth: 6, Thickness: 0.25 });
    addOpeningToStore(mm.editor, resolveHostAnchor(mm.store, slab.slabId, mm.view), { Position: [4, 3], Width: 2, Depth: 1 });
    expect(values(mm.view, slab.slabId, 'Qto_SlabBaseQuantities')).toMatchObject({ Width: 250, Length: 8000, Perimeter: 28000, GrossArea: 48, NetArea: 46, NetVolume: 11.5 });
  });

  it('honours a project that declares its areas and volumes in other units', async () => {
    const declared = await session('IFC4', (text) => text
      .replace(/IFCSIUNIT\(\*,\.AREAUNIT\.,\$,\.SQUARE_METRE\.\)/, 'IFCSIUNIT(*,.AREAUNIT.,.MILLI.,.SQUARE_METRE.)')
      .replace(/IFCSIUNIT\(\*,\.VOLUMEUNIT\.,\$,\.CUBIC_METRE\.\)/, 'IFCSIUNIT(*,.VOLUMEUNIT.,.MILLI.,.CUBIC_METRE.)'));
    expect(values(declared.view, wallAt(declared).wallId, WALL_QTO)).toMatchObject({ GrossSideArea: 15_000_000, GrossVolume: 3_000_000_000 });
  });
});

describe('a loaded file is untouched', () => {
  /** A file with one wall: its own quantity set when `qto`, none when not. */
  function loadedWall(qto: boolean): string {
    const creator = new IfcCreator({ Name: 'Third party', Schema: 'IFC4' });
    const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const wallId = creator.addIfcWall(storeyId, { Start: [0, 0, 0], End: [5, 0, 0], Thickness: 0.2, Height: 3 });
    const text = creator.toIfc().content;
    if (!qto) return text;
    return text.replace('ENDSEC;\nEND-ISO', `#90001=IFCQUANTITYLENGTH('Length',$,$,123.,$);
#90002=IFCELEMENTQUANTITY('0qtoSet00000000000001',$,'${WALL_QTO}',$,$,(#90001));
#90003=IFCRELDEFINESBYPROPERTIES('0qtoRel00000000000001',$,$,$,(#${wallId}),#90002);
ENDSEC;
END-ISO`);
  }
  const wallOf = (store: IfcDataStore): number => store.entityIndex.byType.get('IFCWALL')![0];
  const body = (text: string): string => text.slice(text.indexOf('DATA;'));

  async function open(text: string) {
    const store = await parse(text);
    const view = new MutablePropertyView(null, 'm');
    install(view, store);
    return { store, view, wall: wallOf(store) };
  }

  it('invents no quantities for an element it did not create', async () => {
    const { view, wall } = await open(loadedWall(false));
    expect(view.getQuantitiesForEntity(wall)).toEqual([]);
  });

  it('reads the file\'s own numbers, however wrong they look', async () => {
    const { view, wall } = await open(loadedWall(true));
    expect(values(view, wall, WALL_QTO)).toEqual({ Length: 123 });
  });

  it('exports with the same data section', async () => {
    const text = loadedWall(false);
    const { store, view } = await open(text);
    const plain = new StepExporter(store).export({ schema: 'IFC4' }).content;
    const through = new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content;
    expect(body(new TextDecoder().decode(through))).toBe(body(new TextDecoder().decode(plain)));
  });

  it('adds the authored element\'s set beside a loaded wall and leaves the wall without one', async () => {
    const { store, view, wall } = await open(loadedWall(false));
    const editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, store.entityIndex.byType.get('IFCBUILDINGSTOREY')![0], view);
    const added = addWallToStore(editor, anchor, { Start: [0, 2, 0], End: [3, 2, 0], Thickness: 0.2, Height: 3 }).wallId;
    const reopened = await parse(new TextDecoder().decode(new StepExporter(store, view).export({ schema: 'IFC4', applyMutations: true }).content));
    expect(fileQuantities(reopened, wall, WALL_QTO)).toEqual({});
    expect(fileQuantities(reopened, added, WALL_QTO).Length).toBe(3);
  });

  it('gives an aliased copy of a loaded wall its source\'s set, not a derived one', async () => {
    const { store, view, wall } = await open(loadedWall(true));
    const editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, store.entityIndex.byType.get('IFCBUILDINGSTOREY')![0], view);
    const copy = addWallToStore(editor, anchor, { Start: [0, 2, 0], End: [3, 2, 0], Thickness: 0.2, Height: 3 }).wallId;
    view.setEntityAlias(copy, wall);
    expect(values(view, copy, WALL_QTO)).toEqual({ Length: 123 });
  });
});

describe.skipIf(!existsSync(WASM_PATH))('net volume against the mesh kernel', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  function meshVolumes(text: string): Map<number, number> {
    const bytes = new TextEncoder().encode(text);
    api.setComputeGeometryHashes(1e-3);
    const pre = api.buildPrePassOnce(bytes);
    const volumes = new Map<number, number>();
    try {
      const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
      const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        const ids = collection.geometryHashIds;
        const measured = collection.geometryVolumeValues;
        for (let i = 0; i < ids.length; i++) volumes.set(ids[i], measured[i]);
      } finally {
        collection.free();
      }
    } finally {
      api.clearPrePassCache();
    }
    return volumes;
  }

  it('the door-cut wall, the plain slab and the column all agree with their meshes', async () => {
    const s = await session();
    const wall = wallAt(s).wallId;
    addHostedElementInStore(s.store, s.editor, wall, { kind: 'door', params: { Offset: 1.5, Width: 1, Height: 2 } });
    const slab = addSlabToStore(s.editor, s.anchor, { Position: [10, 0, 0], Width: 8, Depth: 6, Thickness: 0.25 });
    addOpeningToStore(s.editor, resolveHostAnchor(s.store, slab.slabId, s.view), { Position: [4, 3], Width: 2, Depth: 1 });
    const column = addColumnToStore(s.editor, s.anchor, { Position: [1, 8, 0], Width: 0.3, Depth: 0.4, Height: 3 }).columnId;

    const meshed = meshVolumes(exportText(s));
    expect(meshed.get(wall)).toBeCloseTo(values(s.view, wall, WALL_QTO).NetVolume, 3);
    expect(meshed.get(slab.slabId)).toBeCloseTo(values(s.view, slab.slabId, 'Qto_SlabBaseQuantities').NetVolume, 3);
    expect(meshed.get(column)).toBeCloseTo(values(s.view, column, 'Qto_ColumnBaseQuantities').NetVolume, 3);
  });
});
