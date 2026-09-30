/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a wall hosts, as far as its length is concerned (#6232 C1): each
 * opening cut into it (`IfcRelVoidsElement`) with the stretch of the wall it
 * takes, so a trim can refuse to cut through one and a move of the wall's
 * placement can put every opening back where it was.
 *
 * Positions are along the wall's own X from its placement origin, the frame
 * an opening's placement is written in (`lib/wall-opening-reassign.ts`); the
 * doors and windows that fill an opening are placed relative to it and follow.
 * Lengths are metres, except `location`, which is the opening placement's
 * point as the file spells it (native units), for a writer.
 */

import { iterateEffectiveEntityIds, type MutablePropertyView, type StoreEditor } from '@ifc-lite/mutations';
import { placedBodyExtent, readHostedFill } from '@ifc-lite/create';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getModelLengthUnitScale } from './length-unit-scale.js';
import { asExpressIdRef, readAttributes } from './placement-core.js';

export interface HostedCut {
  readonly openingId: number;
  /** The door or window filling it, when there is one. */
  readonly fillingId: number | null;
  /** The opening's Location point and its coordinates now, native units. */
  readonly locationPointId: number;
  readonly location: readonly [number, number, number];
  /** The cut's extent along the wall from its placement origin, metres. */
  readonly from: number;
  readonly to: number;
}

export interface HostedCuts {
  readonly cuts: readonly HostedCut[];
  /** Openings (or void relationships) whose place could not be read: not placed against the wall, no body, an unresolvable reference. The caller must not guess. */
  readonly unreadable: readonly number[];
}

/** The openings cut into `wallId`, read through the overlay so this session's edits count. */
export function readHostedCuts(
  dataStore: IfcDataStore,
  view: MutablePropertyView,
  editor: Pick<StoreEditor, 'getNewEntity'>,
  wallId: number,
): HostedCuts {
  const scale = getModelLengthUnitScale(dataStore);
  const cuts: HostedCut[] = [];
  const unreadable: number[] = [];
  for (const { expressId: relId } of iterateEffectiveEntityIds(dataStore, view, ['IFCRELVOIDSELEMENT'])) {
    const rel = readAttributes(dataStore, view, editor, relId);
    // A relationship that cannot be read may be this wall's: it is an opening of unknown place, never skipped.
    if (!rel) {
      unreadable.push(relId);
      continue;
    }
    // IfcRelVoidsElement: RelatingBuildingElement (4), RelatedOpeningElement (5).
    if (asExpressIdRef(rel[4]) !== wallId) continue;
    const openingId = asExpressIdRef(rel[5]);
    if (openingId === null) {
      unreadable.push(relId);
      continue;
    }
    const fill = readHostedFill(dataStore, openingId, view);
    const extent = fill ? placedBodyExtent(dataStore, openingId, view) : null;
    if (!fill || !extent || fill.hostId !== wallId) {
      unreadable.push(openingId);
      continue;
    }
    cuts.push({
      openingId,
      fillingId: fill.fillingId,
      locationPointId: fill.locationPointId,
      location: fill.location,
      from: extent.min[0] * scale,
      to: extent.max[0] * scale,
    });
  }
  return { cuts, unreadable };
}

/** The cuts that fall (even partly) outside `[from, to]` along the wall, with a millimetre of slack. */
export function cutsOutside(cuts: readonly HostedCut[], from: number, to: number): HostedCut[] {
  const slack = 1e-3;
  return cuts.filter((c) => c.from < from - slack || c.to > to + slack);
}
