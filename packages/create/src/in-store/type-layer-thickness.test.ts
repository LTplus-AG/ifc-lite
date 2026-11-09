/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { IfcCreator } from '../index.js';
import { effectiveMetadataRecord, parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolveAuthoringAnchor, readRelatedLists } from './resolve-relations.js';
import { addWallToStore } from './wall.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { generateSpacesFromWalls } from './generate-spaces.js';
import { roomChainInStore } from './room-store.js';
import { polygonArea } from './room-footprint-offset.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { addMaterialLayerSetToStore, addMaterialLayerSetUsageToStore, assignMaterialInStore } from './material.js';
import { readWallMetres } from './wall-size-edit.js';
import { applyLayerThicknessInStore, takeLayerThicknessOutcome, typeOccurrencesInStore } from './type-layer-thickness.js';
import { previewTypeLayerImpact } from './type-layer-impact.js';
import { retargetInheritingLayerUsagesInStore, typeLayerScopeInStore } from './type-layer-inheritance.js';
import { addHostedElementInStore } from './hosted-element.js';

/** A 6 x 4 m room of four joined 0.2 m walls, two of them typed by one wall type, and its generated room. */
async function typedRoom() {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const { store } = await parseModel(new TextEncoder().encode(c.toIfc().content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  const spatial = resolveSpatialAnchor(store, storey, view);
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]] as const;
  const walls = corners.map((p, i) => addWallToStore(editor, spatial, { Start: [p[0], p[1], 0], End: [...corners[(i + 1) % 4], 0], Thickness: .2, Height: 3 }).wallId);
  for (let i = 0; i < 4; i++) joinWallsInStore(editor, store, resolveWallJoinAnchor(store, view), walls[i], walls[(i + 1) % 4]);
  addHostedElementInStore(store, editor, walls[0], { kind: 'door', params: { Offset: 3, Width: .9, Height: 2.1 } });
  const room = generateSpacesFromWalls(editor, store, storey, {}, view).emitted[0].result.spaceId;
  const anchor = resolveAuthoringAnchor(store, view);
  const type = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'WT' }).typeId;
  assignTypeInStore(editor, anchor, type, [walls[0], walls[1]], readRelatedLists(store, 'IfcRelDefinesByType', view));
  const target = { dataStore: store, view, editor };
  /** Give the type a fresh layer set of `thickness` and let its occurrences follow, as an Apply to Type does. */
  const layerType = (thickness: number) => {
    const set = addMaterialLayerSetToStore(editor, anchor, { MaterialLayers: [{ LayerThickness: thickness }] }).layerSetId;
    retargetInheritingLayerUsagesInStore(target, type, set);
    assignMaterialInStore(editor, anchor, set, [type], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
    return applyLayerThicknessInStore(target, typeOccurrencesInStore(target, type));
  };
  const area = () => {
    const chain = roomChainInStore(store, editor, room);
    if (!chain.ok) throw new Error(chain.reason);
    return polygonArea(chain.chain.footprint);
  };
  const net = () => view.getQuantitiesForEntity(room).find(q => q.name === 'Qto_SpaceBaseQuantities')?.quantities.find(q => q.name === 'NetFloorArea')?.value;
  /** Place `layerSet` on a wall through its own usage, centred on its axis, as drawing with a layer default does. */
  const usageOn = (wall: number, layerSet: number, total: number) => {
    const usage = addMaterialLayerSetUsageToStore(editor, anchor, { ForLayerSet: layerSet, LayerSetDirection: 'AXIS2', OffsetFromReferenceLine: -total / 2 }).usageId;
    assignMaterialInStore(editor, anchor, usage, [wall], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
    return usage;
  };
  return { store, view, editor, anchor, walls, room, type, target, layerType, usageOn, area, net };
}

describe('a layered type drives its occurrences, and what they bound follows (#9296 lane U3)', () => {
  it('re-sizes the typed walls, re-meshes the walls joined to them and refits the generated room in the same edit', async () => {
    const m = await typedRoom();
    expect(m.area()).toBeCloseTo(5.8 * 3.8, 6);
    const remesh = m.layerType(.3);
    expect(m.walls.map(id => readWallMetres(m.target, id)?.thickness)).toEqual([.3, .3, .2, .2]);
    // Inside the faces: 0.15 m off the typed south and east walls, 0.1 m off the plain ones.
    expect(m.area()).toBeCloseTo(5.75 * 3.75, 6);
    expect(m.net()).toBeCloseTo(5.75 * 3.75, 6);
    expect(new Set(remesh)).toEqual(new Set([...m.walls, m.room]));
    const outcome = takeLayerThicknessOutcome(m.editor);
    expect(new Set(outcome.remesh)).toEqual(new Set(remesh));
    expect([...outcome.resized].sort()).toEqual([m.walls[0], m.walls[1]].sort());
    expect(outcome.refused).toEqual([]);
    expect(takeLayerThicknessOutcome(m.editor).remesh, 'a take forgets what it returned').toEqual([]);
  });


  it('previews the same impact without applying it: who resizes, which joins, openings and rooms change, and by how much', async () => {
    const m = await typedRoom();
    const before = JSON.stringify(m.view.getNewEntities()), mutations = m.view.getMutations().length;
    const lease = m.view.prepareAtomic(() => undefined);
    const impact = previewTypeLayerImpact(m.target, m.type, .36);
    expect(() => lease.validate(), 'the preview never touches the live overlay or its allocator').not.toThrow();
    expect(JSON.stringify(m.view.getNewEntities())).toBe(before);
    expect(m.view.getMutations().length).toBe(mutations);
    expect(m.walls.map(id => readWallMetres(m.target, id)?.thickness)).toEqual([.2, .2, .2, .2]);
    expect(impact.occurrences.length).toBe(2);
    expect(impact.resized).toEqual([{ id: m.walls[0], from: .2, to: .36 }, { id: m.walls[1], from: .2, to: .36 }]);
    expect(impact.differing).toEqual([]);
    expect(impact.refused).toEqual([]);
    expect(new Set(impact.joined)).toEqual(new Set([m.walls[2], m.walls[3]]));
    expect(impact.openings.length, 'the door opening (cut 0.3 m deep) is re-cut through 0.36 m').toBe(1);
    expect(impact.rooms.map(r => r.id)).toEqual([m.room]);
    expect(impact.rooms[0].netFloorArea.before).toBeCloseTo(5.8 * 3.8, 6);
    expect(impact.rooms[0].netFloorArea.after).toBeCloseTo(5.72 * 3.72, 6);
    // Applying it changes exactly what the preview said.
    const applied = m.layerType(.36);
    expect(new Set(applied)).toEqual(new Set(impact.remesh));
    expect(m.net()).toBeCloseTo(impact.rooms[0].netFloorArea.after!, 9);
  });

  it('counts an occurrence with its own material out of the preview', async () => {
    const m = await typedRoom();
    const anchor = resolveAuthoringAnchor(m.store, m.view);
    const own = addMaterialLayerSetToStore(m.editor, anchor, { MaterialLayers: [{ LayerThickness: .2 }] }).layerSetId;
    assignMaterialInStore(m.editor, anchor, own, [m.walls[1]], readRelatedLists(m.store, 'IfcRelAssociatesMaterial', m.view));
    const impact = previewTypeLayerImpact(m.target, m.type, .3);
    expect(impact.differing).toEqual([m.walls[1]]);
    expect(impact.resized.map(r => r.id)).toEqual([m.walls[0]]);
    expect(() => previewTypeLayerImpact(m.target, m.type, 0)).toThrow(/positive/);
  });

  it('reaches a wall whose own usage places the type\'s set, and leaves one whose layers differ (#9296)', async () => {
    const m = await typedRoom();
    m.layerType(.2);
    const typeSet = typeLayerScopeInStore(m.target, m.type).layerSetId!;
    // walls[1] was drawn with the type while a layer default was active: its usage places the type's own set.
    const inherited = m.usageOn(m.walls[1], typeSet, .2);
    // walls[2] is typed too, but its usage places a set of its own.
    assignTypeInStore(m.editor, m.anchor, m.type, [m.walls[2]], readRelatedLists(m.store, 'IfcRelDefinesByType', m.view));
    const ownSet = addMaterialLayerSetToStore(m.editor, m.anchor, { MaterialLayers: [{ LayerThickness: .2 }] }).layerSetId;
    m.usageOn(m.walls[2], ownSet, .2);
    expect(typeLayerScopeInStore(m.target, m.type)).toEqual({ layerSetId: typeSet, inheriting: [m.walls[0], m.walls[1]], differing: [m.walls[2]] });
    const impact = previewTypeLayerImpact(m.target, m.type, .3);
    expect(impact.resized.map(r => r.id)).toEqual([m.walls[0], m.walls[1]]);
    expect(impact.differing).toEqual([m.walls[2]]);
    takeLayerThicknessOutcome(m.editor);
    m.layerType(.3);
    expect(m.walls.map(id => readWallMetres(m.target, id)?.thickness)).toEqual([.3, .3, .2, .2]);
    const usage = effectiveMetadataRecord(m.store, inherited, m.view)!.attributes;
    expect(usage[0], 'the usage now places the type\'s new set').toBe(typeLayerScopeInStore(m.target, m.type).layerSetId);
    expect(Number(usage[3]), 'and stays centred on the wall axis').toBeCloseTo(-.15, 9);
    expect(typeLayerScopeInStore(m.target, m.type).inheriting).toEqual([m.walls[0], m.walls[1]]);
    expect(takeLayerThicknessOutcome(m.editor).refused).toEqual([]);
  });
});
