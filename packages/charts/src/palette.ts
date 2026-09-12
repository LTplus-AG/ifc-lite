/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Bucket colours: the lens palette first (so a chart legend and a lens rule
 * for the same category agree), then the lens's golden-angle generator for
 * the long tail.
 *
 * Colours are assigned by LABEL and kept across re-aggregations: a bucket
 * that drops from first to third place when the scope changes keeps its
 * colour, otherwise every slice swaps hue on each 3D pick and the legend
 * stops being readable as a key. A consumer threads the previous
 * `PaletteAssignment` through; new labels take the lowest unused slot.
 */
import { LENS_PALETTE, uniqueColor } from '@ifc-lite/lens';

/** label → colour, plus the next free slot so a new label never reuses one. */
export interface PaletteAssignment {
  colors: Map<string, string>;
  nextSlot: number;
}

/** Colour for the i-th slot: the 12 lens presets, then generated hues. */
export function paletteColor(slot: number): string {
  return slot < LENS_PALETTE.length ? LENS_PALETTE[slot] : uniqueColor(slot);
}

export const OTHER_BUCKET_KEY = '__other__';
/** `Other` is always the same neutral grey, whatever slot it would have had. */
export const OTHER_BUCKET_COLOR = '#9E9E9E';

export function emptyPalette(): PaletteAssignment {
  return { colors: new Map(), nextSlot: 0 };
}

/**
 * Extend `previous` with colours for `labels` (in the given order) and return
 * the new assignment. `previous` is not mutated.
 */
export function assignColors(labels: readonly string[], previous: PaletteAssignment = emptyPalette()): PaletteAssignment {
  const colors = new Map(previous.colors);
  let nextSlot = previous.nextSlot;
  for (const label of labels) {
    if (colors.has(label)) continue;
    if (label === OTHER_BUCKET_KEY) {
      colors.set(label, OTHER_BUCKET_COLOR);
      continue;
    }
    colors.set(label, paletteColor(nextSlot));
    nextSlot += 1;
  }
  return { colors, nextSlot };
}
