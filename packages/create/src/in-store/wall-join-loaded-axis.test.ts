/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { describe, expect, it } from 'vitest';
import { IfcCreator } from '../index.js';
import { StepExporter } from '@ifc-lite/export';
import { parseModel } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { resolveAuthoringAnchor, readRelatedLists } from './resolve-relations.js';
import { addWallToStore } from './wall.js';
import { joinWallsInStore, resolveWallJoinAnchor } from './wall-join-edit.js';
import { setWallSectionInStore } from './wall-section-edit.js';
import { addElementTypeToStore, assignTypeInStore } from './element-type.js';
import { addMaterialLayerSetToStore, assignMaterialInStore } from './material.js';
import { applyLayerThicknessInStore, typeOccurrencesInStore } from './type-layer-thickness.js';
import { retargetInheritingLayerUsagesInStore } from './type-layer-inheritance.js';
import { readWallMetres } from './wall-size-edit.js';

const text = (content: unknown) => typeof content === 'string' ? content : new TextDecoder().decode(content as Uint8Array);
const exportOf = (m: Session) => text(new StepExporter(m.store, m.view).export({ schema: 'IFC4', applyMutations: true }).content);

/** Records of `types` no other record references: a representation must belong to a product shape, map or aspect (IfcShapeModel.WR11). */
function unreferenced(step: string, types: readonly string[]): string[] {
  const lines = step.split('\n');
  return lines.filter(line => types.some(type => line.includes(`=${type}(`))).map(line => /^#(\d+)=/.exec(line)![1])
    .filter(id => !lines.some(line => !line.startsWith(`#${id}=`) && new RegExp(`#${id}(?![0-9])`).test(line.replace(/^#\d+=/, ''))));
}

type Session = Awaited<ReturnType<typeof session>>;
async function session(content: string) {
  const { store } = await parseModel(new TextEncoder().encode(content), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm');
  return { store, dataStore: store, view, editor: new StoreEditor(store, view) };
}

/** A typed, joined 6 x 4 m enclosure written by this session, exported and parsed back as a loaded file. */
async function loadedEnclosure() {
  const c = new IfcCreator();
  const storey = c.addIfcBuildingStorey({ Name: 'Ground', Elevation: 0 });
  const m = await session(text(c.toIfc().content));
  const spatial = resolveSpatialAnchor(m.store, storey, m.view);
  const corners = [[0, 0], [6, 0], [6, 4], [0, 4]] as const;
  const walls = corners.map((p, i) => addWallToStore(m.editor, spatial, { Start: [p[0], p[1], 0], End: [...corners[(i + 1) % 4], 0], Thickness: .2, Height: 3 }).wallId);
  for (let i = 0; i < 4; i++) joinWallsInStore(m.editor, m.store, resolveWallJoinAnchor(m.store, m.view), walls[i], walls[(i + 1) % 4]);
  const type = addElementTypeToStore(m.editor, resolveAuthoringAnchor(m.store, m.view), { Type: 'IfcWallType', Name: 'WT' }).typeId;
  assignTypeInStore(m.editor, resolveAuthoringAnchor(m.store, m.view), type, walls, readRelatedLists(m.store, 'IfcRelDefinesByType', m.view));
  const written = exportOf(m);
  expect(unreferenced(written, ['IFCSHAPEREPRESENTATION'])).toEqual([]);
  return { loaded: await session(written), walls, type };
}

describe('rewriting a LOADED wall leaves no representation without an owner (#9296)', () => {
  it('a resized joined wall drops the axis representations the file gave it and its neighbours, with their curves and points', async () => {
    const { loaded, walls } = await loadedEnclosure();
    const before = exportOf(loaded);
    expect(setWallSectionInStore(loaded, walls[1], { thickness: .25 }).ok).toBe(true);
    const after = exportOf(loaded);
    expect(unreferenced(after, ['IFCSHAPEREPRESENTATION'])).toEqual([]);
    const strayGeometry = (step: string) => unreferenced(step, ['IFCPOLYLINE', 'IFCCARTESIANPOINT']).length;
    expect(strayGeometry(after), 'the replaced axes take their curves and points with them').toBe(strayGeometry(before));
  });

  it('a type layer edit on the reopened model re-sizes every wall and still writes a valid export', async () => {
    const { loaded, walls, type } = await loadedEnclosure();
    const anchor = resolveAuthoringAnchor(loaded.store, loaded.view);
    const set = addMaterialLayerSetToStore(loaded.editor, anchor, { MaterialLayers: [{ LayerThickness: .3 }] }).layerSetId;
    retargetInheritingLayerUsagesInStore(loaded, type, set);
    assignMaterialInStore(loaded.editor, anchor, set, [type], readRelatedLists(loaded.store, 'IfcRelAssociatesMaterial', loaded.view));
    applyLayerThicknessInStore(loaded, typeOccurrencesInStore(loaded, type));
    expect(walls.map(id => readWallMetres(loaded, id)?.thickness)).toEqual([.3, .3, .3, .3]);
    expect(unreferenced(exportOf(loaded), ['IFCSHAPEREPRESENTATION'])).toEqual([]);
  });
});
