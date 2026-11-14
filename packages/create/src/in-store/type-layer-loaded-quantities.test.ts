/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { QuantityType } from '@ifc-lite/data';
import { IfcCreator } from '../index.js';
import { StepExporter } from '@ifc-lite/export';
import { extractQuantitiesOnDemand, parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolveAuthoringAnchor, readRelatedLists } from './resolve-relations.js';
import { addWallToStore } from './wall.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { addMaterialLayerSetToStore, assignMaterialInStore } from './material.js';
import { applyLayerThicknessInStore, typeOccurrencesInStore } from './type-layer-thickness.js';
import { retargetInheritingLayerUsagesInStore } from './type-layer-inheritance.js';
import { readWallMetres } from './wall-size-edit.js';

const text = (content: unknown) => typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
const QTO = 'Qto_WallBaseQuantities';

type Session = Awaited<ReturnType<typeof session>>;
async function session(content: string) {
  const { store } = await parseModel(new TextEncoder().encode(content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, dataStore: store, view, editor: new StoreEditor(store, view) };
}
const exportOf = (m: Session) => text(new StepExporter(m.store, m.view).export({ schema: 'IFC4', applyMutations: true }).content);
/** The wall's base quantities as stored: the file's set with this session's quantity edits over it. */
const qto = (m: Session, id: number) => Object.fromEntries((m.view.getQuantitiesForEntity(id, base => extractQuantitiesOnDemand(m.store, base, m.view))
  .find(set => set.name === QTO)?.quantities ?? []).map(q => [q.name, q.value]));
/** The body's own volume: width x (axis length with its join cuts) x height. */
function bodyVolume(m: Session, id: number): number {
  const w = readWallMetres(m, id)!;
  const wall = w.read!.wall;
  const axis = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1]);
  return w.thickness * (axis + (wall.startCut?.left ?? 0) + (wall.endCut?.left ?? 0)) * w.height;
}
function editType(m: Session, type: number, thickness: number): void {
  const anchor = resolveAuthoringAnchor(m.store, m.view);
  const set = addMaterialLayerSetToStore(m.editor, anchor, { MaterialLayers: [{ LayerThickness: thickness }] }).layerSetId;
  retargetInheritingLayerUsagesInStore(m, type, set);
  assignMaterialInStore(m.editor, anchor, set, [type], readRelatedLists(m.store, 'IfcRelAssociatesMaterial', m.view));
  applyLayerThicknessInStore(m, typeOccurrencesInStore(m, type));
}

/**
 * A model as another tool writes it: four joined 200 mm walls typed by a wall
 * type whose layer set says 230 mm, each with its own Qto_WallBaseQuantities
 * (Width 0.2 and the 200 mm volumes), exported and loaded back.
 */
async function importedModel() {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const m = await session(text(c.toIfc().content));
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]] as const;
  const walls = corners.map((p, i) => addWallToStore(m.editor, resolveSpatialAnchor(m.store, storey, m.view), { Start: [p[0], p[1], 0], End: [...corners[(i + 1) % 4], 0], Thickness: .2, Height: 3 }).wallId);
  for (let i = 0; i < 4; i++) joinWallsInStore(m.editor, m.store, resolveWallJoinAnchor(m.store, m.view), walls[i], walls[(i + 1) % 4]);
  const anchor = resolveAuthoringAnchor(m.store, m.view);
  const type = addElementTypeToStore(m.editor, anchor, { Type: 'IfcWallType', Name: 'WT-230' }).typeId;
  assignTypeInStore(m.editor, anchor, type, walls, readRelatedLists(m.store, 'IfcRelDefinesByType', m.view));
  const set = addMaterialLayerSetToStore(m.editor, anchor, { MaterialLayers: [{ LayerThickness: .23 }] }).layerSetId;
  assignMaterialInStore(m.editor, anchor, set, [type], readRelatedLists(m.store, 'IfcRelAssociatesMaterial', m.view));
  for (const id of walls) {
    const volume = bodyVolume(m, id);
    m.view.setQuantity(id, QTO, 'Width', .2, QuantityType.Length);
    m.view.setQuantity(id, QTO, 'Height', 3, QuantityType.Length);
    m.view.setQuantity(id, QTO, 'GrossVolume', volume, QuantityType.Volume);
    m.view.setQuantity(id, QTO, 'NetVolume', volume, QuantityType.Volume);
  }
  const loaded = await session(exportOf(m));
  for (const id of walls) expect(qto(loaded, id).Width).toBe(.2);
  return { loaded, walls, type };
}

function expectQuantitiesFollow(m: Session, walls: readonly number[], t: number, label: string): void {
  for (const id of walls) {
    const q = qto(m, id);
    expect(readWallMetres(m, id)?.thickness, `${label}: body`).toBeCloseTo(t, 9);
    expect(q.Width, `${label}: #${id} Width`).toBeCloseTo(t, 9);
    expect(q.GrossVolume, `${label}: #${id} GrossVolume`).toBeCloseTo(bodyVolume(m, id), 6);
    expect(q.NetVolume, `${label}: #${id} NetVolume`).toBeCloseTo(bodyVolume(m, id), 6);
    expect(q.Height, `${label}: #${id} keeps the file's own Height`).toBe(3);
  }
}

describe('a type edit refreshes the base quantities a LOADED wall carries from its file (#9296)', () => {
  it('Width and the volumes follow the regenerated body, through export, reopen and a second edit', async () => {
    const { loaded, walls, type } = await importedModel();
    editType(loaded, type, .3);
    expectQuantitiesFollow(loaded, walls, .3, 'after the edit');
    const reopened = await session(exportOf(loaded));
    expectQuantitiesFollow(reopened, walls, .3, 'exported and reopened');
    editType(reopened, type, .25);
    expectQuantitiesFollow(reopened, walls, .25, 'edited again after reopen');
  });

  it('a body brought back to its file thickness takes the file values back', async () => {
    const { loaded, walls, type } = await importedModel();
    editType(loaded, type, .3);
    editType(loaded, type, .2);
    expectQuantitiesFollow(loaded, walls, .2, 'back at the file thickness');
  });
});
