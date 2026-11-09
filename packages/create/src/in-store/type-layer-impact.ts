/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a type layer edit would change, before it is applied (#9296 lane U3).
 *
 * A layer edit on a shared type re-sizes every occurrence that has no material
 * of its own, re-trims the walls joined to them, moves their openings and
 * refits the generated rooms they bound. `previewTypeLayerImpact` runs exactly
 * that edit (`resizeLayeredInStore`, the write path an applied edit takes) on a
 * prepared overlay draft that is never published, and reports what it touched:
 * live IFC state, its allocator and its history are left as they were.
 */

import { StoreEditor } from '@ifc-lite/mutations';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import type { EditTarget } from './edit/target.js';
import { liveEntityConforms, readRelatedLists } from './resolve-relations.js';
import { bodyThickness, layeredKind, resizeLayeredInStore, resizeStep, typeOccurrencesInStore } from './type-layer-thickness.js';

export interface TypeLayerImpact {
  /** Every occurrence the type types. */
  readonly occurrences: readonly number[];
  /** Occurrences whose body would take the new total, with their thickness before and after (metres). */
  readonly resized: readonly { readonly id: number; readonly from: number | null; readonly to: number }[];
  /** Occurrences with a material of their own, which keep it (and their body). */
  readonly keepOwn: readonly number[];
  /** Occurrences whose body could not follow, and why; each would keep its shape. */
  readonly refused: readonly { readonly id: number; readonly reason: string }[];
  /** Other walls whose bodies would change because they are joined to a resized one. */
  readonly joined: readonly number[];
  /** Openings re-cut through the new thickness. */
  readonly openings: readonly number[];
  /** Generated rooms that would take a new outline, with their NetFloorArea before and after (m²). */
  readonly rooms: readonly { readonly id: number; readonly netFloorArea: { readonly before: number | null; readonly after: number | null } }[];
  /** Rooms that could not follow, in plain language. */
  readonly notices: readonly string[];
  /** Every element whose mesh the edit would rebuild. */
  readonly remesh: readonly number[];
}

/**
 * The impact of giving `typeId` a layer set `thickness` metres thick in total,
 * without applying it. Throws on a non-positive or non-finite thickness.
 */
export function previewTypeLayerImpact(target: Pick<EditTarget, 'dataStore' | 'view'>, typeId: number, thickness: number): TypeLayerImpact {
  if (!(Number.isFinite(thickness) && thickness > 0)) throw new Error('A layer set total must be a positive finite thickness');
  const { dataStore } = target;
  const occurrences = typeOccurrencesInStore(target, typeId);
  // Any material association on the occurrence overrides its type's, as everywhere in IFC.
  const own = new Set(readRelatedLists(dataStore, 'IfcRelAssociatesMaterial', target.view).flatMap(rel => rel.relatedIds));
  const keepOwn = occurrences.filter(id => own.has(id));
  const followers = occurrences.filter(id => !own.has(id));
  const prepared = target.view.prepareAtomic(view => {
    const draft = { dataStore, view, editor: new StoreEditor(dataStore, view) };
    const plan = followers.flatMap(id => {
      const kind = layeredKind(draft, id);
      const step = kind && resizeStep(draft, id, kind, thickness);
      return step ? [step] : [];
    });
    const from = new Map(plan.map(step => [step.id, bodyThickness(draft, step.id, step.kind) ?? null]));
    const outcome = resizeLayeredInStore(draft, plan);
    const planned = new Set(plan.map(step => step.id));
    const is = (id: number, ifcClass: string) => liveEntityConforms(dataStore, id, ifcClass, view);
    return {
      occurrences,
      resized: outcome.resized.map(id => ({ id, from: from.get(id) ?? null, to: plan.find(step => step.id === id)!.thickness })),
      keepOwn,
      refused: outcome.refused,
      joined: outcome.remesh.filter(id => !planned.has(id) && is(id, 'IfcWall')),
      openings: outcome.remesh.filter(id => is(id, 'IfcOpeningElement')),
      rooms: outcome.remesh.filter(id => is(id, 'IfcSpace'))
        .map(id => ({ id, netFloorArea: { before: netFloorArea(target.view, id), after: netFloorArea(view, id) } })),
      notices: outcome.notices,
      remesh: outcome.remesh,
    };
  });
  // Never committed: the draft, its new ids and its quantities are discarded with it.
  return prepared.result;
}

function netFloorArea(view: MutablePropertyView, spaceId: number): number | null {
  const value = view.getQuantitiesForEntity(spaceId).find(set => set.name === 'Qto_SpaceBaseQuantities')
    ?.quantities.find(q => q.name === 'NetFloorArea')?.value;
  return typeof value === 'number' ? value : null;
}
