/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcRelConnectsPathElements`: two path elements (walls) joined at their
 * start, end or along the path (#6232 D1). The attribute layout comes from the
 * target schema's registry, so IFC2X3, IFC4 and IFC4X3 are all written right;
 * IFC5 / IFCX are refused.
 *
 *   GlobalId, OwnerHistory?, Name?, Description?, ConnectionGeometry?,
 *   RelatingElement, RelatedElement, RelatingPriorities, RelatedPriorities,
 *   RelatedConnectionType, RelatingConnectionType
 *
 * The priorities are the material-layer priorities at the joint; they are
 * mandatory lists, written empty when the caller has none.
 *
 * Pure: writes through the editor only.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchorSchema } from './anchor.js';
import { ownerHistoryRef } from './_emit-helpers.js';
import { conformsTo, schemaAttributes, schemaRegistry } from './schema-attributes.js';
import type { WallConnectionType } from './wall-join.js';

/** The anchor fields the relationship needs. A full `SpatialAnchor` or an `AuthoringAnchor` both fit. */
export interface RelConnectsAnchor {
  ownerHistoryId: number | null;
  /** Default IFC4. */
  schema?: SpatialAnchorSchema;
  guidRandom?: RandomSource;
}

export interface RelConnectsPathElementsParams {
  /** The element that runs through (for a T, the one whose path is joined). */
  RelatingElement: number;
  RelatedElement: number;
  RelatingConnectionType: WallConnectionType;
  RelatedConnectionType: WallConnectionType;
  /** Layer priorities of the relating element at the joint. Default empty. */
  RelatingPriorities?: readonly number[];
  /** Layer priorities of the related element at the joint. Default empty. */
  RelatedPriorities?: readonly number[];
  Name?: string;
  Description?: string;
}

const CONNECTION_TYPES: readonly string[] = ['ATSTART', 'ATEND', 'ATPATH'];

export function addRelConnectsPathElementsToStore(
  editor: StoreEditor,
  anchor: RelConnectsAnchor,
  params: RelConnectsPathElementsParams,
): number {
  const attributes = relConnectsPathElementsAttributes(editor, anchor, params, 'addRelConnectsPathElementsToStore');
  return editor.addEntity('IfcRelConnectsPathElements', attributes as Parameters<StoreEditor['addEntity']>[1]).expressId;
}

/** Validate `params` and lay out the relationship's attributes, without writing anything. */
export function relConnectsPathElementsAttributes(
  editor: StoreEditor,
  anchor: RelConnectsAnchor,
  params: RelConnectsPathElementsParams,
  op: string,
): unknown[] {
  const registry = schemaRegistry(anchor.schema, op);
  const { RelatingElement: relating, RelatedElement: related } = params;
  for (const id of [relating, related]) {
    if (!Number.isInteger(id) || id <= 0 || !editor.hasEntity(id)) throw new Error(`${op}: #${id} is not a live entity`);
    const type = editor.getEntityType(id);
    if (!type || !conformsTo(registry, type, 'IfcElement')) {
      throw new Error(`${op}: #${id} is ${type ?? 'unknown'}, not an IfcElement`);
    }
  }
  if (relating === related) throw new Error(`${op}: an element cannot connect to itself`);
  for (const value of [params.RelatingConnectionType, params.RelatedConnectionType]) {
    if (!CONNECTION_TYPES.includes(value)) throw new Error(`${op}: connection type must be ATSTART, ATEND or ATPATH; got ${String(value)}`);
  }
  const priorities = (list: readonly number[] | undefined, name: string): number[] => {
    const values = [...(list ?? [])];
    if (values.some((v) => !Number.isInteger(v) || v < 0 || v > 100)) {
      throw new Error(`${op}: ${name} must be integers between 0 and 100`);
    }
    return values;
  };
  return schemaAttributes(registry, 'IfcRelConnectsPathElements', {
    GlobalId: generateIfcGuid(anchor.guidRandom),
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
    Name: params.Name,
    Description: params.Description,
    RelatingElement: `#${relating}`,
    RelatedElement: `#${related}`,
    RelatingPriorities: priorities(params.RelatingPriorities, 'RelatingPriorities'),
    RelatedPriorities: priorities(params.RelatedPriorities, 'RelatedPriorities'),
    RelatedConnectionType: params.RelatedConnectionType,
    RelatingConnectionType: params.RelatingConnectionType,
  }, op);
}
