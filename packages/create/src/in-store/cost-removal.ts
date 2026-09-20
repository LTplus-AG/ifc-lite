/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Safe removal of loaded-model cost entities and their relationship references. */

import type { StoreEditor } from '@ifc-lite/mutations';
import { assertCostSchema } from '../cost-authoring-rules.js';
import { requireEntityTypeOneOf, requireMatchingCostSchema } from './cost-reference-validation.js';
import type { CostAnchor } from './cost.js';

const REMOVABLE_COST_ENTITY_TYPES = new Set(['IFCCOSTSCHEDULE', 'IFCCOSTITEM', 'IFCCOSTVALUE']);

/** Every reference the caller found pointing at the entity being removed. */
export interface CostRemovalReferrers {
  itemCostValues?: ReadonlyMap<number, readonly number[]>;
  valueComponents?: ReadonlyMap<number, readonly number[]>;
  valueAppliedValueRef?: ReadonlyMap<number, number>;
  nestRelatedObjects?: ReadonlyMap<number, readonly number[]>;
  assignmentRelatedObjects?: ReadonlyMap<number, readonly number[]>;
  nestsAsParent?: readonly number[];
  assignmentsAsControl?: readonly number[];
  /** Other relationship list attributes that can retain their surviving members. */
  otherRelationshipLists?: readonly {
    relId: number;
    attributeIndex: number;
    relatedIds: readonly number[];
  }[];
  /** Relationships where the target occupies a required scalar endpoint. */
  otherRelationships?: readonly number[];
  /** Non-relationship entities whose optional scalar attribute references the target. */
  optionalScalarReferrers?: readonly {
    entityId: number;
    attributeIndex: number;
  }[];
  /** Non-relationship entities whose optional list attribute contains the target. */
  optionalListReferrers?: readonly {
    entityId: number;
    attributeIndex: number;
    referencedIds: readonly number[];
  }[];
}

/**
 * Safe-delete an `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue`, refusing
 * live value references unless `detach` explicitly requests their rewrite.
 */
export function removeCostEntityInStore(
  editor: StoreEditor,
  anchor: CostAnchor,
  expressId: number,
  referrers: CostRemovalReferrers,
  options: { detach?: boolean } = {},
): void {
  assertCostSchema(requireMatchingCostSchema(editor, anchor.schema), 'removeCostEntity');
  requireEntityTypeOneOf(editor, expressId, REMOVABLE_COST_ENTITY_TYPES, 'expressId', 'removeCostEntity');
  const blockers: string[] = [];
  for (const [itemId, values] of referrers.itemCostValues ?? []) {
    if (values.includes(expressId)) blockers.push(`IfcCostItem #${itemId}.CostValues`);
  }
  for (const [valueId, components] of referrers.valueComponents ?? []) {
    if (components.includes(expressId)) blockers.push(`IfcCostValue #${valueId}.Components`);
  }
  for (const [valueId, ref] of referrers.valueAppliedValueRef ?? []) {
    if (ref === expressId) blockers.push(`IfcCostValue #${valueId}.AppliedValue (AppliedValueRef)`);
  }
  for (const ref of referrers.otherRelationshipLists ?? []) {
    if (ref.relatedIds.includes(expressId)) blockers.push(`relationship #${ref.relId}`);
  }
  for (const relId of referrers.otherRelationships ?? []) blockers.push(`relationship #${relId}`);
  for (const ref of referrers.optionalScalarReferrers ?? []) {
    blockers.push(`entity #${ref.entityId} attribute ${ref.attributeIndex}`);
  }
  for (const ref of referrers.optionalListReferrers ?? []) {
    if (ref.referencedIds.includes(expressId)) {
      blockers.push(`entity #${ref.entityId} attribute ${ref.attributeIndex}`);
    }
  }
  if (blockers.length > 0 && !options.detach) {
    throw new Error(
      `removeCostEntity: #${expressId} is still referenced by ${blockers.join(', ')}. `
      + 'Pass { detach: true } to rewrite those lists first.',
    );
  }
  if (blockers.length > 0) {
    for (const [itemId, values] of referrers.itemCostValues ?? []) {
      if (!values.includes(expressId)) continue;
      const remaining = values.filter(id => id !== expressId);
      editor.setPositionalAttribute(itemId, 7, remaining.length === 0 ? null : remaining.map(id => `#${id}`));
    }
    for (const [valueId, components] of referrers.valueComponents ?? []) {
      if (!components.includes(expressId)) continue;
      const remaining = components.filter(id => id !== expressId);
      editor.setPositionalAttribute(valueId, 9, remaining.length === 0 ? null : remaining.map(id => `#${id}`));
    }
    for (const [valueId, ref] of referrers.valueAppliedValueRef ?? []) {
      if (ref === expressId) editor.setPositionalAttribute(valueId, 2, null);
    }
    for (const ref of referrers.otherRelationshipLists ?? []) {
      if (!ref.relatedIds.includes(expressId)) continue;
      const remaining = ref.relatedIds.filter(id => id !== expressId);
      if (remaining.length === 0) editor.removeEntity(ref.relId);
      else editor.setPositionalAttribute(
        ref.relId, ref.attributeIndex, remaining.map(id => `#${id}`),
      );
    }
    for (const relId of referrers.otherRelationships ?? []) editor.removeEntity(relId);
    for (const ref of referrers.optionalScalarReferrers ?? []) {
      editor.setPositionalAttribute(ref.entityId, ref.attributeIndex, null);
    }
    for (const ref of referrers.optionalListReferrers ?? []) {
      if (!ref.referencedIds.includes(expressId)) continue;
      const remaining = ref.referencedIds.filter(id => id !== expressId);
      editor.setPositionalAttribute(
        ref.entityId,
        ref.attributeIndex,
        remaining.length === 0 ? null : remaining.map(id => `#${id}`),
      );
    }
  }
  for (const [relId, related] of referrers.nestRelatedObjects ?? []) {
    if (!related.includes(expressId)) continue;
    const remaining = related.filter(id => id !== expressId);
    if (remaining.length === 0) editor.removeEntity(relId);
    else editor.setPositionalAttribute(relId, 5, remaining.map(id => `#${id}`));
  }
  for (const [relId, related] of referrers.assignmentRelatedObjects ?? []) {
    if (!related.includes(expressId)) continue;
    const remaining = related.filter(id => id !== expressId);
    if (remaining.length === 0) editor.removeEntity(relId);
    else editor.setPositionalAttribute(relId, 4, remaining.map(id => `#${id}`));
  }
  for (const relId of referrers.nestsAsParent ?? []) editor.removeEntity(relId);
  for (const relId of referrers.assignmentsAsControl ?? []) editor.removeEntity(relId);
  editor.removeEntity(expressId);
}
