/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { BAFU_CLASSES, BAFU_LEGEND } from '../src/bafu/dataset.js';
import { HazardStyleChangedError } from '../src/errors.js';
import { classifyRgba } from '../src/legend.js';
import { decodePng } from '../src/png.js';
import { CELL_NO_RUNOFF, CELL_UNCLASSIFIED } from '../src/types.js';
import { CODE, fixture, rgbaPng } from './helpers.js';

const decode = (name: string) => classifyRgba(decodePng(fixture(name)).rgba, BAFU_LEGEND, BAFU_CLASSES);

describe('BAFU legend', () => {
  it('pins the published legend colours and class bounds', () => {
    expect(BAFU_LEGEND.map((e) => [e.classId, ...e.rgb])).toEqual([
      ['depth-0-0.1', 255, 189, 255],
      ['depth-0.1-0.25', 223, 115, 255],
      ['depth-gt-0.25', 132, 0, 168],
      ['watercourse', 0, 166, 255],
      ['glacier', 222, 245, 255],
    ]);
    expect(BAFU_CLASSES.map((c) => [c.id, c.lowerBound, c.upperBound])).toEqual([
      ['depth-0-0.1', 0, 0.1],
      ['depth-0.1-0.25', 0.1, 0.25],
      ['depth-gt-0.25', 0.25, null],
      ['watercourse', 0, null],
      ['glacier', 0, null],
    ]);
  });

  it('matches the swatches of the recorded legend image exactly', () => {
    const img = decodePng(fixture('legend-de.png'));
    const counts = new Map<string, number>();
    for (let i = 0; i < img.rgba.length; i += 4) {
      if (img.rgba[i + 3] !== 255) continue;
      const key = `${img.rgba[i]},${img.rgba[i + 1]},${img.rgba[i + 2]}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    // Each swatch is a solid block of 160 pixels.
    for (const entry of BAFU_LEGEND) expect(counts.get(entry.rgb.join())).toBe(160);
  });
});

describe('classifyRgba on recorded responses', () => {
  it('classifies only exact opaque legend colours; blended edges stay unclassified', () => {
    // Expected counts come from an independent decode (Python zlib) of the same bytes.
    const three = decode('bern-three-classes-200px.png');
    expect(three.counts).toMatchObject({
      total: 40000,
      noRunoff: 9979,
      unclassifiedTranslucent: 1369,
      unclassifiedOpaque: 237,
      classified: 17615 + 710 + 10090,
    });
    expect(three.counts.byClass).toMatchObject({ 'depth-0-0.1': 17615, 'depth-0.1-0.25': 710, 'depth-gt-0.25': 10090, watercourse: 0 });
    // (167, 0) is opaque 247/171/255: a blend of two classes, never rounded to the nearest one.
    expect(three.cells[0 * 200 + 167]).toBe(CELL_UNCLASSIFIED);

    const aare = decode('bern-aare-watercourse-100px.png');
    expect(aare.counts.byClass).toMatchObject({
      'depth-0-0.1': 1586,
      'depth-0.1-0.25': 624,
      'depth-gt-0.25': 193,
      watercourse: 2525,
      glacier: 0,
    });
    expect(aare.counts).toMatchObject({ noRunoff: 4116, unclassifiedTranslucent: 873, unclassifiedOpaque: 83 });

    const sparse = decode('bern-sparse-200px.png');
    expect(sparse.counts).toMatchObject({ noRunoff: 33748, unclassifiedTranslucent: 1565, unclassifiedOpaque: 113 });

    const uniform = decode('bern-uniform-9px.png');
    expect(uniform.counts.byClass['depth-0-0.1']).toBe(81);
    expect([...new Set(uniform.cells)]).toEqual([CODE['depth-0-0.1']]);
  });

  it('maps transparency to "no runoff" and partial alpha to unclassified', () => {
    const png = rgbaPng(3, 1, (x) => [[255, 189, 255, 0], [255, 189, 255, 128], [255, 189, 255, 255]][x]);
    const { cells } = classifyRgba(decodePng(png).rgba, BAFU_LEGEND, BAFU_CLASSES);
    expect([...cells]).toEqual([CELL_NO_RUNOFF, CELL_UNCLASSIFIED, CODE['depth-0-0.1']]);
  });

  it('fails loudly when opaque colours match no legend entry in significant numbers', () => {
    // A restyled map: the middle class drawn in green.
    const png = rgbaPng(40, 40, (x) => (x < 20 ? [255, 189, 255, 255] : [0, 200, 0, 255]));
    let error: unknown;
    try {
      classifyRgba(decodePng(png).rgba, BAFU_LEGEND, BAFU_CLASSES);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HazardStyleChangedError);
    const changed = error as HazardStyleChangedError;
    expect(changed.unexplainedPixels).toBe(800);
    expect(changed.colours[0]).toEqual({ rgb: [0, 200, 0], pixels: 800 });
  });

  it('tolerates a handful of stray colours and any number of two-class blends', () => {
    const blends = rgbaPng(40, 40, (x) => {
      const t = x / 39;
      return [Math.round(255 + t * (132 - 255)), Math.round(189 + t * (0 - 189)), Math.round(255 + t * (168 - 255)), 255];
    });
    expect(() => classifyRgba(decodePng(blends).rgba, BAFU_LEGEND, BAFU_CLASSES)).not.toThrow();
    const stray = rgbaPng(40, 40, (x, y) => (x === 0 && y < 5 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    expect(() => classifyRgba(decodePng(stray).rgba, BAFU_LEGEND, BAFU_CLASSES)).not.toThrow();
  });

  it('fails loudly when the style turns translucent', () => {
    const png = rgbaPng(20, 20, () => [255, 189, 255, 180]);
    expect(() => classifyRgba(decodePng(png).rgba, BAFU_LEGEND, BAFU_CLASSES)).toThrow(HazardStyleChangedError);
  });
});
