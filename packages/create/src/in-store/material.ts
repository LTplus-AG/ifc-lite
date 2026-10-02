/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Materials on a loaded model (#6232): IfcMaterial, IfcMaterialLayer +
 * IfcMaterialLayerSet, IfcMaterialLayerSetUsage, and IfcRelAssociatesMaterial.
 *
 * The IFC4 practice for layered walls and slabs is to associate the
 * IfcMaterialLayerSet with the type (`assignMaterialInStore(set, [typeId])`)
 * and an IfcMaterialLayerSetUsage of that set with each occurrence, which
 * says how the layers sit relative to the occurrence's reference line. For a
 * wall that is `LayerSetDirection: 'AXIS2'` (across the wall); for a slab,
 * `'AXIS3'` (up). Layer thicknesses and offsets are metres, converted to the
 * file's native length unit.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import { toNativeLength } from './anchor.js';
import { assertPositiveFinite, ownerHistoryRef } from './_emit-helpers.js';
import { conformsTo, schemaAttributes, schemaRegistry } from './schema-attributes.js';
import { relateOneToManyInStore, type OneToManyResult } from './relate.js';
import type { AuthoringAnchor } from './element-type.js';
import type { ExistingRelatedList } from './cost.js';

type EditorAttributes = Parameters<StoreEditor['addEntity']>[1];

export interface MaterialInStoreParams {
  Name: string;
  /** IFC4+ only. */
  Description?: string;
  /** IFC4+ only, e.g. 'concrete', 'insulation'. */
  Category?: string;
}

export interface MaterialLayerInStoreParams {
  /** The layer's IfcMaterial. Optional in the schema (an air gap has none). */
  Material?: number;
  /** Metres. Zero is allowed (IfcNonNegativeLengthMeasure). */
  LayerThickness: number;
  IsVentilated?: boolean;
  /** IFC4+ only. */
  Name?: string;
  Description?: string;
  Category?: string;
  Priority?: number;
}

export interface MaterialLayerSetInStoreParams {
  /** Outermost first, in the order the layers are stacked along the usage direction. */
  MaterialLayers: MaterialLayerInStoreParams[];
  LayerSetName?: string;
  /** IFC4+ only. */
  Description?: string;
}

export interface MaterialLayerSetBuildResult {
  layerSetId: number;
  layerIds: number[];
}

export interface MaterialLayerSetUsageInStoreParams {
  ForLayerSet: number;
  /** Defaults to 'AXIS2' (across a wall); use 'AXIS3' for slabs. */
  LayerSetDirection?: 'AXIS1' | 'AXIS2' | 'AXIS3';
  /** Defaults to 'POSITIVE'. */
  DirectionSense?: 'POSITIVE' | 'NEGATIVE';
  /** Metres from the reference line to the first layer, e.g. -thickness/2 for a centred wall. */
  OffsetFromReferenceLine: number;
  /** IFC4+ only. */
  ReferenceExtent?: number;
}

function add(editor: StoreEditor, type: string, attrs: unknown[]): number {
  return editor.addEntity(type, attrs as EditorAttributes).expressId;
}

export function addMaterialToStore(editor: StoreEditor, anchor: AuthoringAnchor, params: MaterialInStoreParams): { materialId: number } {
  const op = 'addMaterialToStore';
  if (typeof params.Name !== 'string' || params.Name.length === 0) throw new Error(`${op}: Name is required`);
  const registry = schemaRegistry(anchor.schema, op);
  return { materialId: add(editor, 'IfcMaterial', schemaAttributes(registry, 'IfcMaterial', { ...params }, op)) };
}

export function addMaterialLayerSetToStore(
  editor: StoreEditor,
  anchor: AuthoringAnchor,
  params: MaterialLayerSetInStoreParams,
): MaterialLayerSetBuildResult {
  const op = 'addMaterialLayerSetToStore';
  if (!Array.isArray(params.MaterialLayers) || params.MaterialLayers.length === 0) {
    throw new Error(`${op}: MaterialLayers needs at least one layer`);
  }
  const registry = schemaRegistry(anchor.schema, op);
  // Validate every layer before writing any, so a bad layer leaves nothing behind.
  params.MaterialLayers.forEach((layer, index) => {
    if (!Number.isFinite(layer.LayerThickness) || layer.LayerThickness < 0) {
      throw new Error(`${op}: MaterialLayers[${index}].LayerThickness must be a finite number >= 0`);
    }
    if (layer.Material === undefined) return;
    // IfcMaterialLayer.Material is an IfcMaterial, not any IfcMaterialSelect:
    // a layer set or an element here writes a file other tools reject.
    const type = editor.getEntityType(layer.Material);
    if (!type || !conformsTo(registry, type, 'IfcMaterial')) {
      throw new Error(`${op}: MaterialLayers[${index}].Material #${layer.Material} is ${type ? `an ${type}` : 'not a live entity'}, not an IfcMaterial`);
    }
  });
  // Prepare every schema field before creating helpers: an unsupported late
  // layer or set attribute must leave the live overlay and allocator intact.
  const layerAttributes = params.MaterialLayers.map((layer) => {
    const { Material, ...rest } = layer;
    return schemaAttributes(registry, 'IfcMaterialLayer', {
      ...rest,
      Material: Material === undefined ? undefined : `#${Material}`,
      LayerThickness: toNativeLength(anchor, layer.LayerThickness),
    }, op);
  });
  // schemaAttributes retains this reference list; fill it only after all
  // declarations are validated and each actual layer ID is known.
  const layerReferences: string[] = [];
  const layerSetAttributes = schemaAttributes(registry, 'IfcMaterialLayerSet', {
    MaterialLayers: layerReferences,
    LayerSetName: params.LayerSetName,
    Description: params.Description,
  }, op);
  const layerIds = layerAttributes.map(attributes => {
    const id = add(editor, 'IfcMaterialLayer', attributes);
    layerReferences.push(`#${id}`);
    return id;
  });
  const layerSetId = add(editor, 'IfcMaterialLayerSet', layerSetAttributes);
  return { layerSetId, layerIds };
}

export function addMaterialLayerSetUsageToStore(
  editor: StoreEditor,
  anchor: AuthoringAnchor,
  params: MaterialLayerSetUsageInStoreParams,
): { usageId: number } {
  const op = 'addMaterialLayerSetUsageToStore';
  if (!Number.isFinite(params.OffsetFromReferenceLine)) throw new Error(`${op}: OffsetFromReferenceLine must be finite`);
  if (params.ReferenceExtent !== undefined) assertPositiveFinite([params.ReferenceExtent], `${op}: ReferenceExtent must be positive`);
  const registry = schemaRegistry(anchor.schema, op);
  return {
    usageId: add(editor, 'IfcMaterialLayerSetUsage', schemaAttributes(registry, 'IfcMaterialLayerSetUsage', {
      ForLayerSet: `#${params.ForLayerSet}`,
      LayerSetDirection: params.LayerSetDirection ?? 'AXIS2',
      DirectionSense: params.DirectionSense ?? 'POSITIVE',
      OffsetFromReferenceLine: toNativeLength(anchor, params.OffsetFromReferenceLine),
      ReferenceExtent: params.ReferenceExtent === undefined ? undefined : toNativeLength(anchor, params.ReferenceExtent),
    }, op)),
  };
}

/**
 * Associate `materialId` (an IfcMaterial, IfcMaterialLayerSet,
 * IfcMaterialLayerSetUsage, or any other IfcMaterialSelect) with `objectIds`
 * through IfcRelAssociatesMaterial. `existing` is every
 * IfcRelAssociatesMaterial in the model: the material's own relationship is
 * extended, and an object associated with a different material leaves that
 * association first.
 */
export function assignMaterialInStore(
  editor: StoreEditor,
  anchor: AuthoringAnchor,
  materialId: number,
  objectIds: readonly number[],
  existing: readonly ExistingRelatedList[],
): OneToManyResult {
  return relateOneToManyInStore(editor, {
    relType: 'IfcRelAssociatesMaterial',
    relatingId: materialId,
    relatedIds: objectIds,
    existing,
    create: (related) => [
      generateIfcGuid(anchor.guidRandom),
      ownerHistoryRef(anchor.ownerHistoryId),
      null,
      null,
      related,
      `#${materialId}`,
    ],
  }, 'assignMaterialInStore');
}
