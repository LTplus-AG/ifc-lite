/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The flood-check follow-up: slab holes cut by a Boolean DIFFERENCE, roofing that is not a slab, and small leftovers. */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { parseStep, syntheticHouse, type Extra } from './synthetic-model.js';

const extract = async (extra: (b: Extra) => void) =>
  extractModelFacts(await parseStep(syntheticHouse({ verticalDatum: 'LN02', slab: false, extra })), { expectedCrs: 'EPSG:2056', groundStorey: 'EG' });

/** The ground slab 0..20 x 0..10, 0.3 m thick (z -0.3..0), minus `cut` (built in the slab's coordinates). */
const cutSlab = (cut: (b: Extra) => number, roof?: (b: Extra) => void) => (b: Extra) => {
  const slab = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${cut(b)})`);
  b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte geschnitten',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
  roof?.(b);
};
/** A box 8 x 4 m centred at (10, 5) from z0 to z0 + h. */
const box = (z0: number, h: number, w = 8, d = 4, cx = 10) => (b: Extra) => b.rectExtrusion(cx, 5, w, d, h, b.axis(0, 0, z0), b.dir(0, 0, 1));
const deck = (b: Extra) => {
  const solid = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
  b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke OG',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
};

describe('item 8: a slab hole cut by a Boolean DIFFERENCE is read and classified', () => {
  it('a through cut wholly inside the slab, open above, is a courtyard (not a building-wide voids-filled outline)', async () => {
    const fp = (await extract(cutSlab(box(-1, 2)))).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toHaveLength(1);
  });
  it('the same cut under the slab above is interior: the outline is complete', async () => {
    const fp = (await extract(cutSlab(box(-1, 2), deck))).footprint;
    expect(fp.quality?.worst).toBe('complete');
    expect(fp.quality?.notes.join()).toMatch(/wholly roofed/);
  });
  it('a shallow cut (a recess that leaves slab material under it) is no hole: the outline is complete', async () => {
    const fp = (await extract(cutSlab(box(-0.1, 1), deck))).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('a cut that crosses the slab\'s edge (a notch) stays voids-filled: its effect on the outline is not read', async () => {
    expect((await extract(cutSlab(box(-1, 2, 8, 4, 18)))).footprint.source).toBe('slab-outline-voids-filled');
  });
  it('a cut by a half space stays voids-filled', async () => {
    const half = (b: Extra) => b.add(`IFCHALFSPACESOLID(#${b.add(`IFCPLANE(#${b.axis(0, 0, -0.1)})`)},.F.)`);
    expect((await extract(cutSlab(half))).footprint.source).toBe('slab-outline-voids-filled');
  });
});
