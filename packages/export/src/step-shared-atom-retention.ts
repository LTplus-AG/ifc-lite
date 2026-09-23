/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Keep source property atoms only when an emitted effective container needs them. */
import { resolveEffectiveEntityRecord, type IfcAttributeValue } from '@ifc-lite/parser';
import { authoredEntityRefs, type EffectiveEntityIndex } from './effective-index.js';
import { getPropertyIdsInSet, type PropertySetContext } from './step-property-set-readers.js';

const MEMBER_ATTRIBUTE = new Map([
  ['IFCPROPERTYSET', { name: 'HasProperties', slot: 4 }],
  ['IFCELEMENTQUANTITY', { name: 'Quantities', slot: 5 }],
]);

function memberIds(
  ctx: PropertySetContext,
  effective: EffectiveEntityIndex,
  id: number,
  type: string,
): number[] {
  const member = MEMBER_ATTRIBUTE.get(type);
  if (!member) return [];
  const view = ctx.mutationView;
  if (effective.isOverlayCreated(id)) {
    const created = view?.getNewEntity(id);
    if (!created) return [];
    const record = resolveEffectiveEntityRecord(
      { type: created.type, attributes: created.attributes },
      {
        retype: view?.getTypeMutations?.().get(id)?.newType,
        named: (view?.getAttributeMutationsForEntity(id) ?? []).map(({ name, value }) => [name, value] as const),
        positional: view?.getPositionalMutationsForEntity(id) ?? [],
      },
      ctx.dataStore.schemaVersion,
    );
    const slot = record.names.indexOf(member.name);
    return slot < 0 ? [] : authoredEntityRefs(record.attributes[slot] as IfcAttributeValue | undefined);
  }

  // Positional edits win over named edits in the STEP line. A clear (`null`)
  // is an answer, so use Map.has rather than falling back to source bytes.
  const positional = view?.getPositionalMutationsForEntity(id);
  if (positional?.has(member.slot)) return authoredEntityRefs(positional.get(member.slot));
  const named = view?.getAttributeMutationsForEntity(id) ?? [];
  for (let i = named.length - 1; i >= 0; i--) {
    if (named[i].name === member.name) return authoredEntityRefs(named[i].value);
  }

  // `getPropertyIdsInSet` reads source bytes. A retype into this class has no
  // source member list in this layout; a retype away is absent from byType.
  if (effective.get(id)?.type.toUpperCase() !== type) return [];
  return getPropertyIdsInSet(ctx, id);
}

/** Undo atom skips only for containers that will actually be emitted. */
export function retainSharedAtoms(
  skipIds: Set<number>,
  allowedEntityIds: Set<number> | null,
  effective: EffectiveEntityIndex,
  ctx: PropertySetContext,
): void {
  if (skipIds.size === 0) return;
  for (const type of MEMBER_ATTRIBUTE.keys()) {
    for (const containerId of effective.byType.get(type) ?? []) {
      if (skipIds.has(containerId)) continue;
      if (allowedEntityIds !== null && !allowedEntityIds.has(containerId)) continue;
      for (const atomId of memberIds(ctx, effective, containerId, type)) skipIds.delete(atomId);
    }
  }
}
