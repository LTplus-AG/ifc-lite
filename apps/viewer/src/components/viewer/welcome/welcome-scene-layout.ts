/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Geometry for the start screen's 3D mark, kept free of three.js so it can be
 * tested where WebGL cannot run.
 *
 * The four extrusions are the proportions of `/logo.png`: a tall tower at the
 * back, two medium blocks either side and a short one in front, on a 1.15
 * pitch. Heights are cut at the three band boundaries below, so each band is
 * one "layer" of the composed mark.
 */

/** The IFC `Name` of each extrusion, in `EXTRUSIONS` order. Model data, not
 *  UI copy: an IFC file's names are not translated. */
export const COLUMN_NAMES = ['Tower', 'East', 'West', 'Plinth'] as const;

/** The `.ifcx` layer file each band comes from, bottom to top. */
export const LAYER_FILES = ['base.ifcx', 'storey-2.ifcx', 'tower.ifcx'] as const;

/** Stable 22-character IFC GlobalIds, one per column, so the tag never shuffles. */
const GLOBAL_IDS = ['2mB$0xQ4n7Bvf1kT9zLr3e', '0Kc8Vt1wZ5RgH2nP6yDq9a', '3hW_sE7jLm4uC0bX8fNt1k', '1Zp9Qa3rT6vB_2yG5mHc0s'] as const;

/** [x, y, width, depth, height] in plan, z-up, before centring. */
const EXTRUSIONS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [0, 0, 1, 1, 3.2],
  [1.15, 0, 1, 1, 2.2],
  [0, 1.15, 1, 1, 2.2],
  [1.15, 1.15, 1, 1, 1.2],
];

/** The vertical extent of each layer band, bottom to top. */
export const LAYER_BANDS: ReadonlyArray<readonly [number, number]> = [
  [0, 1.2],
  [1.2, 2.2],
  [2.2, 3.2],
];

/** Plan centre of the four extrusions, so the mark rotates about its middle. */
const CENTRE = 1.075;

/** One box in three.js space (y-up), positioned by its centre. */
export interface BandBox {
  /** Index into `COLUMN_NAMES` / the extrusion list. */
  column: number;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
  /** The box's bottom / top is a cut between layers, not the column's own end.
   *  Cut edges are drawn only while the layers are apart, so the assembled
   *  mark reads as solid columns. */
  cutBelow: boolean;
  cutAbove: boolean;
}

/** Cut every extrusion at the band boundaries; one array of boxes per band. */
export function sliceLogoIntoBands(): BandBox[][] {
  return LAYER_BANDS.map(([lo, hi]) => {
    const boxes: BandBox[] = [];
    EXTRUSIONS.forEach(([x, y, width, depth, height], column) => {
      const bottom = Math.max(0, lo);
      const top = Math.min(height, hi);
      if (top <= bottom) return;
      const h = top - bottom;
      boxes.push({
        column,
        x: x + width / 2 - CENTRE,
        y: bottom + h / 2,
        z: y + depth / 2 - CENTRE,
        width,
        height: h,
        depth,
        cutBelow: bottom > 0,
        cutAbove: top < height,
      });
    });
    return boxes;
  });
}

/** Widest gap between layer bands, model units: apart enough to read as three
 *  layers, close enough to still read as the logo. */
export const MAX_LAYER_GAP = 0.85;

/** One explode cycle, seconds: hold assembled, open, hold open, close. */
const CYCLE = { closed: 3.5, open: 1.6, held: 3.2, close: 1.6 } as const;
const PERIOD = CYCLE.closed + CYCLE.open + CYCLE.held + CYCLE.close;

const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * How far apart the layers are at time `t` seconds, 0 (the assembled logo) to
 * 1 (fully apart). Most of the cycle sits at the two ends; the moves between
 * them ease in and out.
 */
export function explodeAt(t: number): number {
  const p = ((t % PERIOD) + PERIOD) % PERIOD;
  if (p < CYCLE.closed) return 0;
  const opening = p - CYCLE.closed;
  if (opening < CYCLE.open) return smooth(opening / CYCLE.open);
  const held = opening - CYCLE.open;
  if (held < CYCLE.held) return 1;
  return 1 - smooth((held - CYCLE.held) / CYCLE.close);
}

/** What the hover tag says about one sliced box. */
export interface BlockTag {
  name: string;
  globalId: string;
  /** 0-based band index; the tag shows it 1-based. */
  layer: number;
  layerCount: number;
  layerFile: string;
  /** Height of this box (the part inside its layer), metres. */
  height: number;
  /** Full height of the column across all layers, metres. */
  columnHeight: number;
}

export function blockTag(layer: number, column: number): BlockTag {
  const box = sliceLogoIntoBands()[layer]?.find((b) => b.column === column);
  return {
    name: COLUMN_NAMES[column] ?? '',
    globalId: GLOBAL_IDS[column] ?? '',
    layer,
    layerCount: LAYER_BANDS.length,
    layerFile: LAYER_FILES[layer] ?? '',
    height: box?.height ?? 0,
    columnHeight: EXTRUSIONS[column]?.[4] ?? 0,
  };
}
