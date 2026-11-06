/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Smart defaults for a new storey next to an existing one (#9013): the
 * neighbourhood's own floor-to-floor height and naming pattern, so "add
 * above" on `Level 2` at +3.00 with 3.00 spacing proposes `Level 3` at +6.00.
 */

import { storeySpacingAbove, storeyNeighbour, storeyRecord, type StoreyInventory } from './storey-model.js';

/** Used when no neighbour has a floor-to-floor height to copy. */
export const DEFAULT_STOREY_HEIGHT = 3;

export interface StoreySuggestion {
  readonly Name: string;
  /** Metres. */
  readonly Elevation: number;
  /** The floor-to-floor height the suggestion assumes, metres. */
  readonly Height: number;
  readonly referenceStoreyId: number;
}

/**
 * Propose a storey directly above or below `storeyId`. Below a storey that has
 * one under it, the new storey splits the gap evenly; elsewhere it repeats the
 * nearest known spacing. `fallbackName` names the storey when the neighbour's
 * name carries no number to count on (localised by the caller).
 */
export function suggestStorey(
  inventory: StoreyInventory, storeyId: number, side: 'above' | 'below', fallbackName: (index: number) => string,
): StoreySuggestion {
  const reference = storeyRecord(inventory, storeyId);
  const below = storeyNeighbour(inventory, storeyId, -1);
  const above = storeyNeighbour(inventory, storeyId, 1);
  const own = storeySpacingAbove(inventory, storeyId);
  const under = below ? reference.elevation - below.elevation : null;
  const spacing = own ?? under ?? DEFAULT_STOREY_HEIGHT;
  let elevation: number;
  if (side === 'above') {
    elevation = above ? reference.elevation + (above.elevation - reference.elevation) / 2 : reference.elevation + spacing;
  } else {
    elevation = below ? reference.elevation - (reference.elevation - below.elevation) / 2 : reference.elevation - (under ?? spacing);
  }
  elevation = Math.round(elevation * 1000) / 1000;
  const height = side === 'above'
    ? (above ? above.elevation - elevation : spacing)
    : reference.elevation - elevation;
  return { Name: suggestName(inventory, reference.Name, side, fallbackName), Elevation: elevation, Height: height, referenceStoreyId: storeyId };
}

/** `Level 2` → `Level 3` above / `Level 1` below, skipping names already taken. */
export function suggestName(
  inventory: StoreyInventory, referenceName: string, side: 'above' | 'below', fallbackName: (index: number) => string,
): string {
  const taken = new Set(inventory.storeys.map((storey) => storey.Name.trim().toLowerCase()));
  const step = side === 'above' ? 1 : -1;
  const match = /^(.*?)(-?\d+)(\D*)$/.exec(referenceName.trim());
  if (match) {
    const [, prefix, digits, suffix] = match;
    const width = digits.replace('-', '').length;
    for (let n = Number(digits) + step, tries = 0; tries < 1000; n += step, tries++) {
      const padded = (n < 0 ? '-' : '') + String(Math.abs(n)).padStart(width, '0');
      const name = `${prefix}${padded}${suffix}`;
      if (!taken.has(name.toLowerCase())) return name;
    }
  }
  for (let index = inventory.storeys.length + 1; index < inventory.storeys.length + 1000; index++) {
    const name = fallbackName(index);
    if (!taken.has(name.toLowerCase())) return name;
  }
  return fallbackName(inventory.storeys.length + 1);
}
