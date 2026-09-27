/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type objects and materials authored into a parsed store (#6232, M3 builder
 * parity with `IfcCreator.addIfcMaterial` and type authoring).
 *
 * The fixture is the Bonsai hello-wall sample, which already carries an
 * IfcWallType (#388) typing the wall #1222 through IfcRelDefinesByType #1224,
 * and an IfcMaterialLayerSet (#391) on that type through
 * IfcRelAssociatesMaterial #389 — real relationships to extend and detach from.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import {
  MutablePropertyView,
  StoreEditor,
  type MutationEntityRef,
  type MutationStoreShape,
} from '@ifc-lite/mutations';
import { addElementTypeToStore, assignTypeInStore, type AuthoringAnchor } from './element-type.js';
import {
  addMaterialLayerSetToStore,
  addMaterialLayerSetUsageToStore,
  addMaterialToStore,
  assignMaterialInStore,
} from './material.js';
import { readRelatedLists, resolveAuthoringAnchor } from './resolve-relations.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);
const WALL = 1222;
const WALL_TYPE = 388;
const TYPE_REL = 1224;
const MATERIAL_REL = 389;
const WINDOWS = [1262, 1407];

async function session() {
  const bytes = await readFile(SAMPLE);
  const store = await new IfcParser().parseColumnar(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    { disableWorkerScan: true },
  );
  const view = new MutablePropertyView(null, 'm');
  const editor = new StoreEditor(store, view);
  return { store, view, editor, anchor: resolveAuthoringAnchor(store, view) };
}

function created(view: MutablePropertyView, id: number) {
  const entity = view.getNewEntity(id);
  if (!entity) throw new Error(`#${id} was not created`);
  return entity;
}

function synthetic(schema: AuthoringAnchor['schema']) {
  const byId = new Map<number, MutationEntityRef>();
  for (let id = 1; id <= 20; id++) byId.set(id, { expressId: id, type: 'IFCDUMMY', byteOffset: 0, byteLength: 1, lineNumber: id });
  const store: MutationStoreShape = { entityIndex: { byId } };
  const view = new MutablePropertyView(null, 'm');
  return { view, editor: new StoreEditor(store, view), anchor: { ownerHistoryId: 1, schema } satisfies AuthoringAnchor };
}

describe('addElementTypeToStore', () => {
  it('writes the IFC4 IfcDoorType layout with defaulted mandatory enums', async () => {
    const { view, editor, anchor } = await session();
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcDoorType', Name: 'D-90', OperationType: 'SINGLE_SWING_RIGHT' });
    const door = created(view, typeId);
    expect(door.type).toBe('IfcDoorType');
    // Root(4) + ApplicableOccurrence, HasPropertySets, RepresentationMaps, Tag,
    // ElementType + PredefinedType, OperationType, ParameterTakesPrecedence,
    // UserDefinedOperationType.
    expect(door.attributes).toHaveLength(13);
    expect(door.attributes[2]).toBe('D-90');
    expect(door.attributes.slice(9)).toEqual(['.NOTDEFINED.', '.SINGLE_SWING_RIGHT.', null, null]);
  });

  it('follows the schema: IFC2X3 has no IfcDoorType, and IfcWallType keeps its mandatory PredefinedType', () => {
    const { view, editor, anchor } = synthetic('IFC2X3');
    expect(() => addElementTypeToStore(editor, anchor, { Type: 'IfcDoorType', Name: 'D' })).toThrow(/does not exist in IFC2X3/);
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'W', PredefinedType: 'STANDARD' });
    expect(created(view, typeId).attributes).toHaveLength(10);
    expect(created(view, typeId).attributes[9]).toBe('.STANDARD.');
  });

  it('accepts IFC4X3 types and refuses non-types and unknown enum values', () => {
    const { view, editor, anchor } = synthetic('IFC4X3');
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IFCSLABTYPE', Name: 'S', PredefinedType: 'FLOOR' });
    expect(created(view, typeId).type).toBe('IfcSlabType');
    expect(() => addElementTypeToStore(editor, anchor, { Type: 'IfcWall', Name: 'x' })).toThrow(/IfcElementType subtype/);
    expect(() => addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'x', PredefinedType: 'BRICK' }))
      .toThrow(/IfcWallType.PredefinedType must be one of .*SOLIDWALL.*; got BRICK/);
  });
});

describe('assignTypeInStore', () => {
  it('moves an occurrence from its old type relationship to a new one', async () => {
    const { store, view, editor, anchor } = await session();
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcWallType', Name: 'W-300', PredefinedType: 'SOLIDWALL' });
    const result = assignTypeInStore(editor, anchor, typeId, [WALL], readRelatedLists(store, 'IfcRelDefinesByType', view));

    expect(result.created).toBe(true);
    expect(created(view, result.relId).attributes.slice(4)).toEqual([[`#${WALL}`], `#${typeId}`]);
    // #1224 typed only the wall, so it is emptied and removed.
    expect(result.detachedRelIds).toEqual([TYPE_REL]);
    expect(view.isDeleted(TYPE_REL)).toBe(true);

    const lists = readRelatedLists(store, 'IfcRelDefinesByType', view);
    expect(lists.filter((rel) => rel.relatedIds.includes(WALL))).toEqual([
      { relId: result.relId, relatingId: typeId, relatedIds: [WALL] },
    ]);
  });

  it('extends the type\'s existing relationship instead of adding a second one', async () => {
    const { store, view, editor, anchor } = await session();
    const { typeId } = addElementTypeToStore(editor, anchor, { Type: 'IfcWindowType', Name: 'Win' });
    const first = assignTypeInStore(editor, anchor, typeId, [WINDOWS[0]], readRelatedLists(store, 'IfcRelDefinesByType', view));
    const second = assignTypeInStore(editor, anchor, typeId, [WINDOWS[1]], readRelatedLists(store, 'IfcRelDefinesByType', view));
    expect(second).toMatchObject({ relId: first.relId, created: false });
    const lists = readRelatedLists(store, 'IfcRelDefinesByType', view);
    expect(lists.find((rel) => rel.relId === first.relId)?.relatedIds).toEqual(WINDOWS);
    // Both windows left #1283, which typed only them.
    expect(view.isDeleted(1283)).toBe(true);
    // Re-typing the wall's own type onto itself is a no-op on #1224.
    const same = assignTypeInStore(editor, anchor, WALL_TYPE, [WALL], readRelatedLists(store, 'IfcRelDefinesByType', view));
    expect(same).toEqual({ relId: TYPE_REL, created: false, detachedRelIds: [] });
  });
});

describe('materials', () => {
  it('builds a layer set on the type and a usage on the wall (IFC4 practice)', async () => {
    const { store, view, editor, anchor } = await session();
    const concrete = addMaterialToStore(editor, anchor, { Name: 'Concrete', Category: 'concrete' }).materialId;
    const insulation = addMaterialToStore(editor, anchor, { Name: 'Mineral wool' }).materialId;
    expect(created(view, concrete).attributes).toEqual(['Concrete', null, 'concrete']);

    const set = addMaterialLayerSetToStore(editor, anchor, {
      LayerSetName: 'EW-300',
      MaterialLayers: [
        { Material: concrete, LayerThickness: 0.2, Name: 'Core' },
        { Material: insulation, LayerThickness: 0.1, IsVentilated: false, Priority: 10 },
      ],
    });
    expect(created(view, set.layerIds[0]).attributes).toEqual([`#${concrete}`, { real: 0.2 }, null, 'Core', null, null, null]);
    expect(created(view, set.layerIds[1]).attributes).toEqual([`#${insulation}`, { real: 0.1 }, '.F.', null, null, null, 10]);
    expect(created(view, set.layerSetId).attributes).toEqual([set.layerIds.map((id) => `#${id}`), 'EW-300', null]);

    const { usageId } = addMaterialLayerSetUsageToStore(editor, anchor, { ForLayerSet: set.layerSetId, OffsetFromReferenceLine: -0.15 });
    expect(created(view, usageId).attributes).toEqual([`#${set.layerSetId}`, '.AXIS2.', '.POSITIVE.', { real: -0.15 }, null]);

    // The type keeps one material association: it moves off #389 (which held
    // only the type) onto the new set's relationship.
    const onType = assignMaterialInStore(editor, anchor, set.layerSetId, [WALL_TYPE], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
    expect(onType.detachedRelIds).toEqual([MATERIAL_REL]);
    const onWall = assignMaterialInStore(editor, anchor, usageId, [WALL], readRelatedLists(store, 'IfcRelAssociatesMaterial', view));
    expect(created(view, onWall.relId).type).toBe('IfcRelAssociatesMaterial');
    expect(created(view, onWall.relId).attributes.slice(4)).toEqual([[`#${WALL}`], `#${usageId}`]);
    expect(onWall.detachedRelIds).toEqual([]);
  });

  it('writes the IFC2X3 layouts and converts metres to the model unit', () => {
    const { view, editor } = synthetic('IFC2X3');
    const anchor: AuthoringAnchor = { ownerHistoryId: 1, schema: 'IFC2X3', lengthUnitScale: 0.001 };
    expect(() => addMaterialToStore(editor, anchor, { Name: 'C', Category: 'concrete' })).toThrow(/no attribute Category/);
    const material = addMaterialToStore(editor, anchor, { Name: 'C' }).materialId;
    expect(created(view, material).attributes).toEqual(['C']);
    const set = addMaterialLayerSetToStore(editor, anchor, { MaterialLayers: [{ Material: material, LayerThickness: 0.2 }] });
    expect(created(view, set.layerIds[0]).attributes).toEqual([`#${material}`, { real: 200 }, null]);
    const usage = addMaterialLayerSetUsageToStore(editor, anchor, {
      ForLayerSet: set.layerSetId, LayerSetDirection: 'AXIS3', DirectionSense: 'NEGATIVE', OffsetFromReferenceLine: 0.1,
    });
    expect(created(view, usage.usageId).attributes).toEqual([`#${set.layerSetId}`, '.AXIS3.', '.NEGATIVE.', { real: 100 }]);
  });

  it('refuses empty layer sets, negative thicknesses and self-association', () => {
    const { editor, anchor } = synthetic('IFC4');
    expect(() => addMaterialLayerSetToStore(editor, anchor, { MaterialLayers: [] })).toThrow(/at least one layer/);
    expect(() => addMaterialLayerSetToStore(editor, anchor, { MaterialLayers: [{ LayerThickness: -1 }] })).toThrow(/>= 0/);
    expect(() => assignMaterialInStore(editor, anchor, 5, [5], [])).toThrow(/cannot relate to itself/);
    expect(() => assignMaterialInStore(editor, anchor, 5, [], [])).toThrow(/at least one object/);
  });
});
