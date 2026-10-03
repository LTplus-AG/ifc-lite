/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a move or a turn of a selection writes (charter #6232, C2), worked
 * out before anything is written.
 *
 * The moved set is the selection plus what it hosts: a host's openings and
 * the fillings in them, a filling's opening (a window moves with the void it
 * fills), through the same relationship walk the re-mesher uses
 * (`expandAffectedSet`, overlay relationships included).
 *
 * Only the ROOTS of that set are written. An element whose placement hangs,
 * however many hops up, from another moved element's placement already moves
 * with it — an opening placed relative to its wall, a door relative to its
 * opening — and writing it too would move it twice. A filling placed
 * relative to the storey instead is a root and is written like the host.
 *
 * Each root carries its parent placement's frame in its storey's frame, and
 * its own origin there, so a storey-frame move or turn can be written in the
 * frame `translateEntity` / `rotateEntity` work in. A root whose chain does
 * not reach its storey's placement is refused, never moved by a guess.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { expandAffectedSet } from '@ifc-lite/export';
import {
  IDENTITY_FRAME, applyFrame, frameInStorey, objectPlacementOf, placementAncestors, placementOrigin, uprightFrame,
  type PlacementReader, type PlanFrame,
} from './element-transform-frames.js';

type Vec2 = [number, number];

export interface TransformRoot {
  readonly expressId: number;
  readonly storeyId: number;
  /** The parent placement's frame in the storey frame (the identity under the storey). */
  readonly parent: PlanFrame;
  /** The element's placement origin in the storey frame, metres. */
  readonly origin: Vec2;
  /** Its own placement is upright (Z up), so it can be turned about Z. */
  readonly upright: boolean;
}

export interface TransformRefusal {
  readonly expressId: number;
  readonly reason: 'noStorey' | 'noPlacement' | 'offStorey';
}

export interface TransformPlan {
  readonly roots: readonly TransformRoot[];
  /** Moved with a root through their placement chain; re-meshed, never written. */
  readonly carried: readonly number[];
  readonly refused: readonly TransformRefusal[];
}

export interface TransformPlanInput {
  readonly dataStore: IfcDataStore;
  readonly view: MutablePropertyView;
  /** The selected elements (model-local express ids). */
  readonly selected: readonly number[];
  /** The storey an element sits on, or null. */
  storeyOf(expressId: number): number | null;
}

/** The effective IFC class (UPPERCASE): retypes, overlay creations, then the source index — which also knows non-products. */
function typeOf(input: TransformPlanInput, id: number): string {
  const { dataStore, view } = input;
  const edited = view.getEntityTypeMutation(id)?.newType ?? view.getNewEntity(id)?.type;
  if (edited) return edited.toUpperCase();
  // @raw-entity-enumeration-ok point lookup of one id's class; retypes and overlay creations are answered from the view above
  const source = dataStore.entityIndex.byId.get(id)?.type;
  return (source ?? dataStore.entities.getTypeName(id) ?? '').toUpperCase();
}

const isOpening = (type: string) => type === 'IFCOPENINGELEMENT' || type === 'IFCOPENINGSTANDARDCASE';

/**
 * The moved set: each selected element and what moves with it, mapped to the
 * storey whose frame it is written in (the selected element's).
 */
function movedSet(input: TransformPlanInput): Map<number, number | null> {
  const moved = new Map<number, number | null>();
  for (const id of input.selected) moved.set(id, input.storeyOf(id));
  for (const id of input.selected) {
    // A bare opening moves on its own: expanding it would take its host along.
    if (isOpening(typeOf(input, id))) continue;
    for (const dependent of expandAffectedSet(input.dataStore, input.view, [id], 'hostsChanged')) {
      // The walk also returns what is not placed (a material relationship the
      // parser has no type name for): only placed products move.
      if (!moved.has(dependent) && placementOf(input, dependent) !== null) moved.set(dependent, moved.get(id) ?? null);
    }
  }
  return moved;
}

/** A product's `ObjectPlacement` when it is an `IfcLocalPlacement`, else null. */
function placementOf(input: TransformPlanInput, productId: number): number | null {
  const placement = objectPlacementOf(input, productId);
  return placement !== null && typeOf(input, placement) === 'IFCLOCALPLACEMENT' ? placement : null;
}

export function planElementTransform(input: TransformPlanInput): TransformPlan {
  const reader: PlacementReader = { dataStore: input.dataStore, view: input.view };
  const moved = movedSet(input);
  const placements = new Map<number, number>();
  for (const id of moved.keys()) {
    const placement = placementOf(input, id);
    if (placement !== null) placements.set(placement, id);
  }

  const roots: TransformRoot[] = [];
  const carried: number[] = [];
  const refused: TransformRefusal[] = [];
  for (const [expressId, storeyId] of moved) {
    const placement = placementOf(input, expressId);
    if (placement === null) {
      refused.push({ expressId, reason: 'noPlacement' });
      continue;
    }
    const ancestors = placementAncestors(reader, placement);
    if (ancestors.some((p) => placements.has(p))) {
      carried.push(expressId);
      continue;
    }
    if (storeyId === null) {
      refused.push({ expressId, reason: 'noStorey' });
      continue;
    }
    const storeyPlacement = objectPlacementOf(reader, storeyId);
    const parentId = ancestors[0] ?? null;
    const parent = storeyPlacement === null || parentId === null
      ? null
      : parentId === storeyPlacement ? IDENTITY_FRAME : frameInStorey(reader, parentId, storeyPlacement);
    const local = placementOrigin(reader, placement);
    if (!parent || !local) {
      refused.push({ expressId, reason: 'offStorey' });
      continue;
    }
    roots.push({ expressId, storeyId, parent, origin: applyFrame(parent, local), upright: uprightFrame(reader, placement) !== null });
  }
  return { roots, carried, refused };
}
