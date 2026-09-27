/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type objects on a loaded model (#6232): an `IfcElementType` subtype
 * (`IfcWallType`, `IfcSlabType`, `IfcDoorType`, ...) and its
 * `IfcRelDefinesByType` to the occurrences it types.
 *
 * The attribute layout is read from the target schema's registry, so the same
 * call writes a valid IFC2X3, IFC4 or IFC4X3 record, and a class the schema
 * does not have (IFC2X3 has no `IfcDoorType`) is refused by name.
 */

import { generateIfcGuid } from '@ifc-lite/encoding';
import type { StoreEditor } from '@ifc-lite/mutations';
import type { SpatialAnchor } from './anchor.js';
import { ownerHistoryRef, productGuid } from './_emit-helpers.js';
import { canonicalEntity, schemaAttributes, schemaRegistry } from './schema-attributes.js';
import { relateOneToManyInStore, type OneToManyResult } from './relate.js';
import type { ExistingRelatedList } from './cost.js';

/** What the type and material builders need from the model: no storey, no geometry context. */
export type AuthoringAnchor = Pick<SpatialAnchor, 'ownerHistoryId' | 'schema' | 'guidRandom' | 'lengthUnitScale'>;

export interface ElementTypeInStoreParams {
  /** EXPRESS class of the type object, e.g. `'IfcWallType'`. Must be an IfcElementType subtype in the model's schema. */
  Type: string;
  Name: string;
  Description?: string;
  ApplicableOccurrence?: string;
  Tag?: string;
  ElementType?: string;
  /** Enumeration value without dots. Defaults to NOTDEFINED where the attribute is mandatory. */
  PredefinedType?: string;
  /** IfcDoorType (IFC4+). */
  OperationType?: string;
  UserDefinedOperationType?: string;
  /** IfcWindowType (IFC4+). */
  PartitioningType?: string;
  UserDefinedPartitioningType?: string;
  /** IfcDoorType / IfcWindowType (IFC4+). */
  ParameterTakesPrecedence?: boolean;
  /** Explicit GlobalId (22-char IFC GUID); generated when omitted. */
  GlobalId?: string;
}

export interface ElementTypeBuildResult {
  typeId: number;
}

export function addElementTypeToStore(
  editor: StoreEditor,
  anchor: AuthoringAnchor,
  params: ElementTypeInStoreParams,
): ElementTypeBuildResult {
  const op = 'addElementTypeToStore';
  const registry = schemaRegistry(anchor.schema, op);
  const type = canonicalEntity(registry, params.Type);
  if (!type) throw new Error(`${op}: ${params.Type} does not exist in ${registry.name}`);
  const entity = registry.entities[type];
  if (entity.isAbstract || !(entity.inheritanceChain ?? []).includes('IfcElementType')) {
    throw new Error(`${op}: ${type} is not an instantiable IfcElementType subtype`);
  }
  if (typeof params.Name !== 'string' || params.Name.length === 0) throw new Error(`${op}: Name is required`);

  const { Type: _type, GlobalId: _guid, ...named } = params;
  const attrs = schemaAttributes(registry, type, {
    ...named,
    GlobalId: productGuid(params, anchor.guidRandom),
    OwnerHistory: ownerHistoryRef(anchor.ownerHistoryId),
  }, op);
  return { typeId: editor.addEntity(type, attrs as Parameters<StoreEditor['addEntity']>[1]).expressId };
}

/**
 * Type `objectIds` by `typeId` through IfcRelDefinesByType. `existing` is every
 * IfcRelDefinesByType in the model (see `readRelatedLists`): the type's own
 * relationship is extended rather than duplicated, and an object typed by a
 * different type is detached from it first, since an occurrence has at most
 * one type.
 */
export function assignTypeInStore(
  editor: StoreEditor,
  anchor: AuthoringAnchor,
  typeId: number,
  objectIds: readonly number[],
  existing: readonly ExistingRelatedList[],
): OneToManyResult {
  return relateOneToManyInStore(editor, {
    relType: 'IfcRelDefinesByType',
    relatingId: typeId,
    relatedIds: objectIds,
    existing,
    create: (related) => [
      generateIfcGuid(anchor.guidRandom),
      ownerHistoryRef(anchor.ownerHistoryId),
      null,
      null,
      related,
      `#${typeId}`,
    ],
  }, 'assignTypeInStore');
}
