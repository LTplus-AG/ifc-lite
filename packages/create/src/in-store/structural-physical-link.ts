/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Link structural items to the physical element they idealise with
 * `IfcRelAssignsToProduct`: the items in `RelatedObjects`, the element as
 * `RelatingProduct`. Same attributes in IFC2X3, IFC4 and IFC4X3:
 * `GlobalId, OwnerHistory?, Name?, Description?, RelatedObjects,
 * RelatedObjectsType?, RelatingProduct`. `readPhysicalLinks` in
 * `@ifc-lite/parser` reads it back in either orientation.
 */

import { generateIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { conformsTo, schemaRegistry } from './schema-attributes.js';
import type { StoreEditor } from '@ifc-lite/mutations';
import { ownerHistoryRef } from './_emit-helpers.js';

export function linkStructuralItemsToPhysicalInStore(
  editor: StoreEditor,
  ownerHistoryId: number | null,
  physicalElementId: number,
  itemIds: readonly number[],
  random?: RandomSource,
): number {
  if (itemIds.length === 0) {
    throw new Error('linkStructuralItemsToPhysicalInStore: itemIds must be non-empty (IfcRelAssignsToProduct.RelatedObjects is SET [1:?])');
  }
  if (itemIds.includes(physicalElementId)) {
    throw new Error('linkStructuralItemsToPhysicalInStore: an item cannot be linked to itself');
  }
  return editor.addEntity('IfcRelAssignsToProduct', [
    generateIfcGuid(random),
    ownerHistoryRef(ownerHistoryId),
    null,
    null,
    itemIds.map((id) => `#${id}`),
    null, // RelatedObjectsType
    `#${physicalElementId}`,
  ]).expressId;
}

/** IFC2X3 physical-to-analytical relationship, absent from IFC4+. */
export function connectStructuralElementInStore(editor: StoreEditor, ownerHistoryId: number | null, RelatingElement: number, RelatedStructuralMember: number, random?: RandomSource): number {
  if (editor.getSchemaVersion() !== 'IFC2X3') throw new Error('connectStructuralElementInStore: IfcRelConnectsStructuralElement exists only in IFC2X3');
  if (!ownerHistoryId) throw new Error('connectStructuralElementInStore: IFC2X3 requires OwnerHistory');
  const registry = schemaRegistry('IFC2X3', 'connectStructuralElementInStore');
  if (!conformsTo(registry, editor.getEntityType(RelatingElement) ?? '', 'IfcElement') || !conformsTo(registry, editor.getEntityType(RelatedStructuralMember) ?? '', 'IfcStructuralMember')) throw new Error('connectStructuralElementInStore: requires an IfcElement and an IfcStructuralMember');
  return editor.addEntity('IfcRelConnectsStructuralElement', [generateIfcGuid(random), ownerHistoryRef(ownerHistoryId), null, null, `#${RelatingElement}`, `#${RelatedStructuralMember}`]).expressId;
}
