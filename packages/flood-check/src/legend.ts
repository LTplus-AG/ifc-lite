/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Exact colour decoding of a rendered hazard map.
 *
 * A map server antialiases polygon edges, so a pixel on a boundary is a blend
 * of two classes (or of a class and transparency). Rounding such a pixel to
 * the nearest legend colour would invent a class, so only fully opaque pixels
 * whose RGB equals a legend colour exactly are classified. Everything else is
 * counted as unclassified.
 *
 * Opaque pixels that are neither a legend colour nor a plausible blend of two
 * legend colours mean the published style changed; that throws
 * {@link HazardStyleChangedError} instead of returning a raster that silently
 * reads as "no runoff".
 */

import { HazardStyleChangedError, type UnexplainedColour } from './errors.js';
import {
  CELL_NO_RUNOFF,
  CELL_UNCLASSIFIED,
  type HazardCellCounts,
  type HazardClassDefinition,
} from './types.js';

/** One legend colour and the class it stands for. */
export interface LegendEntry {
  rgb: readonly [number, number, number];
  classId: string;
}

export interface StyleCheckOptions {
  /**
   * Unexplained opaque pixels tolerated, as a share of all pixels, before the
   * style counts as changed. Default 0.005 (0.5 %).
   */
  maxUnexplainedShare?: number;
  /** ...and as an absolute count (the larger of the two applies). Default 20. */
  maxUnexplainedPixels?: number;
  /** Per-channel tolerance when testing whether a colour is a blend of two legend colours. Default 3. */
  blendTolerance?: number;
}

export interface DecodedClasses {
  cells: Uint8Array;
  counts: HazardCellCounts;
}

/** Whether `p` lies (within `tol` per channel) on the segment between legend colours `a` and `b`. */
function onSegment(p: readonly number[], a: readonly number[], b: readonly number[], tol: number): boolean {
  let best = -1;
  let bestSpan = 0;
  for (let c = 0; c < 3; c++) {
    const span = b[c] - a[c];
    if (Math.abs(span) > Math.abs(bestSpan)) {
      bestSpan = span;
      best = c;
    }
  }
  if (best < 0) return false;
  const t = (p[best] - a[best]) / bestSpan;
  if (t < -0.02 || t > 1.02) return false;
  for (let c = 0; c < 3; c++) {
    if (Math.abs(a[c] + t * (b[c] - a[c]) - p[c]) > tol) return false;
  }
  return true;
}

/**
 * Classify RGBA pixels against a legend. `classes` fixes the cell codes:
 * `classes[k - 1]` is code `k`.
 */
export function classifyRgba(
  rgba: Uint8Array,
  legend: readonly LegendEntry[],
  classes: readonly HazardClassDefinition[],
  options: StyleCheckOptions = {},
): DecodedClasses {
  const total = rgba.length / 4;
  const codeByKey = new Map<number, number>();
  for (const entry of legend) {
    const index = classes.findIndex((c) => c.id === entry.classId);
    if (index < 0) throw new Error(`legend entry ${entry.classId} has no class definition`);
    codeByKey.set((entry.rgb[0] << 16) | (entry.rgb[1] << 8) | entry.rgb[2], index + 1);
  }
  const cells = new Uint8Array(total);
  const byClass: Record<string, number> = {};
  for (const c of classes) byClass[c.id] = 0;
  let classified = 0;
  let noRunoff = 0;
  let unclassifiedOpaque = 0;
  let unclassifiedTranslucent = 0;
  const unmatched = new Map<number, number>();
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const alpha = rgba[o + 3];
    if (alpha === 0) {
      cells[i] = CELL_NO_RUNOFF;
      noRunoff++;
      continue;
    }
    if (alpha !== 255) {
      cells[i] = CELL_UNCLASSIFIED;
      unclassifiedTranslucent++;
      continue;
    }
    const key = (rgba[o] << 16) | (rgba[o + 1] << 8) | rgba[o + 2];
    const code = codeByKey.get(key);
    if (code === undefined) {
      cells[i] = CELL_UNCLASSIFIED;
      unclassifiedOpaque++;
      unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
      continue;
    }
    cells[i] = code;
    classified++;
    byClass[classes[code - 1].id]++;
  }

  const tol = options.blendTolerance ?? 3;
  const colours: UnexplainedColour[] = [];
  let unexplained = 0;
  for (const [key, pixels] of unmatched) {
    const p = [(key >> 16) & 255, (key >> 8) & 255, key & 255];
    let explained = false;
    for (let a = 0; a < legend.length && !explained; a++) {
      for (let b = a + 1; b < legend.length && !explained; b++) {
        explained = onSegment(p, legend[a].rgb, legend[b].rgb, tol);
      }
    }
    if (!explained) {
      unexplained += pixels;
      colours.push({ rgb: [p[0], p[1], p[2]], pixels });
    }
  }
  const limit = Math.max(options.maxUnexplainedPixels ?? 20, (options.maxUnexplainedShare ?? 0.005) * total);
  if (unexplained > limit) {
    colours.sort((x, y) => y.pixels - x.pixels);
    throw new HazardStyleChangedError(
      `${unexplained} of ${total} pixels are opaque colours that match no legend entry and are no blend of two entries; the map style has changed`,
      unexplained,
      total,
      colours.slice(0, 10),
    );
  }
  // A style that moved to translucent fills would decode as "all unclassified"; say so instead.
  const painted = total - noRunoff;
  if (painted > Math.max(limit, 50) && unclassifiedTranslucent > 0.5 * painted) {
    throw new HazardStyleChangedError(
      `${unclassifiedTranslucent} of ${painted} painted pixels are translucent; the map style has changed`,
      unclassifiedTranslucent,
      total,
      [],
    );
  }
  return {
    cells,
    counts: { total, classified, noRunoff, unclassifiedOpaque, unclassifiedTranslucent, byClass },
  };
}
