/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** The flood-check follow-up: slab holes cut by a Boolean DIFFERENCE, roofing that is not a slab, and small leftovers. */

import { describe, expect, it } from 'vitest';
import { extractModelFacts } from '../src/model/extract.js';
import { completeness, readSlabOutline } from '../src/model/outline.js';
import { ModelReader } from '../src/model/reader.js';
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
  it('a shallow cut (a recess that leaves slab material under it) is never filled as a hole', async () => {
    const fp = (await extract(cutSlab(box(-0.1, 1)))).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it.each([
    { name: 'direction (0,0,2), depth 0.2 m is shallow', z: 2, depth: 0.2, through: false },
    { name: 'direction (0,0,2), depth 0.4 m goes through', z: 2, depth: 0.4, through: true },
    { name: 'direction (0,0,0.5), depth 0.2 m is shallow', z: 0.5, depth: 0.2, through: false },
    { name: 'direction (0,0,0.5), depth 0.4 m goes through', z: 0.5, depth: 0.4, through: true },
  ])('normalizes an extrusion direction for a cut: $name (#10503 review round 5)', async ({ z, depth, through }) => {
    const fp = (await extract(cutSlab((b) => b.rectExtrusion(10, 5, 8, 4, depth, b.axis(0, 0, -0.3), b.dir(0, 0, z))))).footprint;
    expect(fp.source).toBe(through ? 'slab-outline' : 'slab-outline-voids-filled');
    if (through) expect(fp.courtyardRings).toHaveLength(1);
    else expect(fp.courtyardRings).toBeUndefined();
  });
  it('a zero-length extrusion direction leaves the cut unreadable, not a through hole (#10503 review round 5)', async () => {
    const fp = (await extract(cutSlab((b) => b.rectExtrusion(10, 5, 8, 4, 0.4, b.axis(0, 0, -0.3), b.dir(0, 0, 0))))).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('two partial-depth cuts that jointly remove the slab thickness remain unreadable until their combined effect is proven', async () => {
    const fp = (await extract((b) => {
      const slab = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const lowerHalf = b.rectExtrusion(10, 5, 8, 4, 0.2, b.axis(0, 0, -0.3), b.dir(0, 0, 1));
      const first = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${lowerHalf})`);
      const upperHalf = b.rectExtrusion(10, 5, 8, 4, 0.2, b.axis(0, 0, 0.1), b.dir(0, 0, -1));
      const second = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${upperHalf})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte mit versetzten Schnitten',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([second])},$,.FLOOR.)`));
    })).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('a slightly tilted cut is not treated as a vertical through hole', async () => {
    const fp = (await extract((b) => {
      const slab = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const angle = 8 * Math.PI / 180;
      const tilted = b.rectExtrusion(0, 0, 8, 4, 2, b.axis(10, 5, -1, b.dir(0, Math.sin(angle), Math.cos(angle)), b.dir(1, 0, 0)), b.dir(0, 0, 1));
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${tilted})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte mit geneigtem Schnitt',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
      const roof = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 2), b.dir(0, 0, 1));
      b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke über Schnitt',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([roof])},$,.FLOOR.)`));
    })).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('a near-tolerance tilt is checked at every profile vertex before it can become a roofed hole', async () => {
    const fp = (await extract((b) => {
      const slab = b.rectExtrusion(5, 50, 10, 100, 0.3, b.axis(0, 0, 0), b.dir(0, 0, 1));
      const tilt = 5e-7;
      const cut = b.rectExtrusion(5, 50, 8, 98, 0.30001, b.axis(0, 0, 0.0000395, b.dir(0, tilt, 1), b.dir(1, 0, 0)), b.dir(0, -tilt, 1));
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${cut})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte mit fast waagerechtem Schnitt',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
      const roof = b.rectExtrusion(5, 50, 10, 100, 0.3, b.axis(0, 0, 2), b.dir(0, 0, 1));
      b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Decke über Schnitt',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([roof])},$,.FLOOR.)`));
    })).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
    expect(fp.courtyardRings).toBeUndefined();
  });
  it('a cut edge that exits and re-enters a concave slab between all corner and midpoint probes is not a hole', async () => {
    const fp = (await extract((b) => {
      const pt = (x: number, y: number) => b.pt2(x, y);
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const outline = loop([[0, 0], [10, 0], [10, 10], [4, 10], [4, 3], [3, 3], [3, 10], [0, 10]]);
      const profile = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${outline})`);
      const slabSolid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, 1)},0.3)`);
      const cut = b.rectExtrusion(5, 5, 6, 2, 2, b.axis(0, 0, -1), b.dir(0, 0, 1));
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slabSolid},#${cut})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte mit Aussparung',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
    })).footprint;
    expect(fp.source).toBe('slab-outline-voids-filled');
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

describe('item 5: roofing that is not a slab counts, over the hole\'s whole area', () => {
  /** The ground slab 0..20 x 0..10 with a hole 6..14 x 3..7 in its profile, and `roof` above it. */
  const holedUnder = (roof: (b: Extra) => void) => (b: Extra) => {
    const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x}.,${y}.))`);
    const loop = (pts: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
    const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[0, 0], [20, 0], [20, 10], [0, 10]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
    const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
    b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Bodenplatte gelocht',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    roof(b);
  };
  /** An element of `record` (its arguments after the placement and shape) whose body is a flat 0.1 m plate over x0..x1, y 2.5..7.5, 3 m up. */
  const flat = (cls: string, tail: string, x0 = 5, x1 = 15) => (b: Extra) => {
    const plate = b.rectExtrusion((x0 + x1) / 2, 5, x1 - x0, 5, 0.1, b.axis(0, 0, 3), b.dir(0, 0, 1));
    b.contain(b.storeys.eg.id, b.add(`${cls}(${b.guid()},$,'Dach',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([plate])},${tail})`));
  };
  const courtyards = async (roof: (b: Extra) => void) => (await extract(holedUnder(roof))).footprint.courtyardRings?.length ?? 0;

  it('control: with nothing above, the hole is a courtyard', async () => {
    expect(await courtyards(() => {})).toBe(1);
  });
  it('an IfcRoof body over the whole hole roofs it', async () => {
    expect(await courtyards(flat('IFCROOF', '$,.FLAT_ROOF.'))).toBe(0);
  });
  it('an IfcCovering of type ROOFING roofs it; a CEILING covering does not count as roofing', async () => {
    expect(await courtyards(flat('IFCCOVERING', '$,.ROOFING.'))).toBe(0);
    expect(await courtyards(flat('IFCCOVERING', '$,.CEILING.'))).toBe(1);
  });
  it('a skylight (an IfcWindow lying flat over the hole) roofs it', async () => {
    expect(await courtyards(flat('IFCWINDOW', '$,10.,5.,.SKYLIGHT.,$,$'))).toBe(0);
  });
  it('an IfcPlate over only half the hole leaves it open', async () => {
    expect(await courtyards(flat('IFCPLATE', '$,.CURTAIN_PANEL.', 5, 10))).toBe(1);
  });
  it('a roofing profile with its own void does not roof the courtyard', async () => {
    const roofWithVoid = (b: Extra) => {
      const pt = (x: number, y: number) => b.add(`IFCCARTESIANPOINT((${x}.,${y}.))`);
      const loop = (pts: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...pts, pts[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[4, 2], [16, 2], [16, 8], [4, 8]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 3)},#${b.dir(0, 0, 1)},0.1)`);
      b.contain(b.storeys.eg.id, b.add(`IFCROOF(${b.guid()},$,'Dach mit Aussparung',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLAT_ROOF.)`));
    };
    expect(await courtyards(roofWithVoid)).toBe(1);
  });
  it('a narrow notch through a roof is not missed by coverage samples', async () => {
    const roofWithNotch = (b: Extra) => {
      const pt = (x: number, y: number) => b.pt2(x, y);
      const outline = b.add(`IFCPOLYLINE((${[[4, 2], [9.9, 2], [9.9, 5], [10.1, 5], [10.1, 2], [16, 2], [16, 8], [4, 8], [4, 2]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const profile = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${outline})`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 3)},#${b.dir(0, 0, 1)},0.1)`);
      b.contain(b.storeys.eg.id, b.add(`IFCROOF(${b.guid()},$,'Dach mit schmaler Aussparung',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLAT_ROOF.)`));
    };
    expect(await courtyards(roofWithNotch)).toBe(1);
  });

  it('a courtyard jointly roofed by two abutting deck slabs is interior (#10503 review round 4)', async () => {
    const splitDecks = (b: Extra) => {
      const pt = (x: number, y: number) => b.pt2(x, y);
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const addDeck = (x0: number, x1: number) => {
        const profile = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${loop([[x0, 2.5], [x1, 2.5], [x1, 7.5], [x0, 7.5]])})`);
        const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
        b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Deck ${x0} to ${x1}',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
      };
      addDeck(5, 10);
      addDeck(10, 15);
    };
    const fp = (await extract(holedUnder(splitDecks))).footprint;
    expect(fp.courtyardRings).toBeUndefined();
    expect(fp.quality?.worst).toBe('complete');
  });

  it('a courtyard roofed half by a deck slab and half by an IfcRoof is interior (#10503 review round 4)', async () => {
    const mixedRoof = (b: Extra) => {
      const pt = (x: number, y: number) => b.pt2(x, y);
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const leftProfile = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${loop([[5, 2.5], [10, 2.5], [10, 7.5], [5, 7.5]])})`);
      const leftSolid = b.add(`IFCEXTRUDEDAREASOLID(#${leftProfile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Deck left',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([leftSolid])},$,.FLOOR.)`));
      const rightSolid = b.rectExtrusion(12.5, 5, 5, 5, 0.1, b.axis(0, 0, 3), b.dir(0, 0, 1));
      b.contain(b.storeys.eg.id, b.add(`IFCROOF(${b.guid()},$,'Roof right',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([rightSolid])},$,.FLAT_ROOF.)`));
    };
    const fp = (await extract(holedUnder(mixedRoof))).footprint;
    expect(fp.courtyardRings).toBeUndefined();
    expect(fp.quality?.worst).toBe('complete');
  });

  it('a 0.6 m gap between two decks leaves the courtyard open (#10503 review round 4)', async () => {
    const decksWithGap = (b: Extra) => {
      const addDeck = (cx: number, width: number) => {
        const solid = b.rectExtrusion(cx, 5, width, 5, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
        b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Deck with gap',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
      };
      addDeck(7.35, 4.7);
      addDeck(12.65, 4.7);
    };
    expect((await extract(holedUnder(decksWithGap))).footprint.courtyardRings).toHaveLength(1);
  });

  it('a deck void over part of the courtyard leaves it open (#10503 review round 4)', async () => {
    const deckWithVoid = (b: Extra) => {
      const pt = (x: number, y: number) => b.pt2(x, y);
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${pt(x, y)}`).join(',')}))`);
      const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[5, 2.5], [15, 2.5], [15, 7.5], [5, 7.5]])},(#${loop([[9, 3], [11, 3], [11, 6], [9, 6]])}))`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      b.contain(b.storeys.og.id, b.add(`IFCSLAB(${b.guid()},$,'Deck with void',$,$,#${b.place(b.storeys.og.pl, 0, 0, 0)},#${b.shape([solid])},$,.FLOOR.)`));
    };
    expect((await extract(holedUnder(deckWithVoid))).footprint.courtyardRings).toHaveLength(1);
  });
});

describe('mapped slab outlines use the mapped-item reader', () => {
  const mappedSlab = (b: Extra, leaf: number, x = 0, y = 0) => {
    const ctx = b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$)")},$,.MODEL_VIEW.,$)`);
    const rep = b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${leaf}))`);
    const map = b.add(`IFCREPRESENTATIONMAP(#${b.axis(0, 0, 0)},#${rep})`);
    const target = b.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#${b.add(`IFCCARTESIANPOINT((${x},${y},0.))`)},$,$)`);
    return b.add(`IFCMAPPEDITEM(#${map},#${target})`);
  };
  const addSlab = (b: Extra, body: number) => b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte gemappt',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));

  it('reads inner profile curves of a mapped slab and keeps its courtyard', async () => {
    const fp = (await extract((b) => {
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${b.pt2(x, y)}`).join(',')}))`);
      const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[0, 0], [20, 0], [20, 10], [0, 10]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      addSlab(b, mappedSlab(b, solid));
    })).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toHaveLength(1);
  });

  it('reads a Boolean cut inside a mapped slab and keeps its courtyard', async () => {
    const fp = (await extract((b) => {
      const solid = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const cut = b.rectExtrusion(10, 5, 8, 4, 2, b.axis(0, 0, -1), b.dir(0, 0, 1));
      const difference = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${solid},#${cut})`);
      addSlab(b, mappedSlab(b, difference));
    })).footprint;
    expect(fp.source).toBe('slab-outline');
    expect(fp.courtyardRings).toHaveLength(1);
  });

  it('applies a mapped target translation to the outline and its hole (#10503 review round 6)', async () => {
    const store = await parseStep(syntheticHouse({ slab: false, extra: (b) => {
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${b.pt2(x, y)}`).join(',')}))`);
      const profile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[0, 0], [20, 0], [20, 10], [0, 10]])},(#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])}))`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      addSlab(b, mappedSlab(b, solid, 3, 4));
    } }));
    const reader = new ModelReader(store);
    const outline = readSlabOutline(reader, reader.idsOfType('IFCSLAB').at(-1)!);
    expect(outline.rings[0]).toEqual([[3, 4, 0], [23, 4, 0], [23, 14, 0], [3, 14, 0], [3, 4, 0]]);
    expect(outline.holes[0]).toEqual([[9, 7, 0], [17, 7, 0], [17, 11, 0], [9, 11, 0], [9, 7, 0]]);
  });

  it('does not call a Y-tilted mapped slab a complete plan outline (#10503 review round 6)', async () => {
    const store = await parseStep(syntheticHouse({ slab: false, extra: (b) => {
      const profile = b.add(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#${b.add(`IFCPOLYLINE((#${b.pt2(0, 0)},#${b.pt2(20, 0)},#${b.pt2(20, 10)},#${b.pt2(0, 10)},#${b.pt2(0, 0)}))`)})`);
      const solid = b.add(`IFCEXTRUDEDAREASOLID(#${profile},#${b.axis(0, 0, 0)},#${b.dir(0, 0, -1)},0.3)`);
      const ctx = b.add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${b.add("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,$,$)")},$,.MODEL_VIEW.,$)`);
      const rep = b.add(`IFCSHAPEREPRESENTATION(#${ctx},'Body','SweptSolid',(#${solid}))`);
      const map = b.add(`IFCREPRESENTATIONMAP(#${b.axis(0, 0, 0)},#${rep})`);
      const angle = Math.PI / 4;
      const target = b.add(`IFCCARTESIANTRANSFORMATIONOPERATOR3D(#${b.dir(Math.cos(angle), 0, -Math.sin(angle))},#${b.dir(0, 1, 0)},#${b.add('IFCCARTESIANPOINT((0.,0.,0.))')},$,#${b.dir(Math.sin(angle), 0, Math.cos(angle))})`);
      const item = b.add(`IFCMAPPEDITEM(#${map},#${target})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Tilted mapped slab',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([item])},$,.FLOOR.)`));
    } }));
    const reader = new ModelReader(store);
    const outline = readSlabOutline(reader, reader.idsOfType('IFCSLAB').at(-1)!);
    expect(completeness(outline)).not.toBe('complete');
  });

  it('keeps a hollow Boolean cutter unreadable until its retained island can be represented (#10503 review round 6)', async () => {
    const store = await parseStep(syntheticHouse({ slab: false, extra: (b) => {
      const loop = (points: Array<[number, number]>) => b.add(`IFCPOLYLINE((${[...points, points[0]].map(([x, y]) => `#${b.pt2(x, y)}`).join(',')}))`);
      const slab = b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1));
      const cutterProfile = b.add(`IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#${loop([[6, 3], [14, 3], [14, 7], [6, 7]])},(#${loop([[9, 4], [11, 4], [11, 6], [9, 6]])}))`);
      const cutter = b.add(`IFCEXTRUDEDAREASOLID(#${cutterProfile},#${b.axis(0, 0, -1)},#${b.dir(0, 0, 1)},2.)`);
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${slab},#${cutter})`);
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Slab with hollow cutter',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([body])},$,.FLOOR.)`));
    } }));
    const reader = new ModelReader(store);
    const outline = readSlabOutline(reader, reader.idsOfType('IFCSLAB').at(-1)!);
    expect(outline.voids).toBe(true);
    expect(outline.holes).toHaveLength(0);
  });
});

describe('item 20: a partial footprint withholds above-mapped-class-range, by that reason', () => {
  it('a window clearing a shallow class gets above-mapped on a complete footprint, and is withheld (partial-footprint named) on a partial one', async () => {
    const { checkFloodExposure } = await import('../src/check/check.js');
    const { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } = await import('./helpers.js');
    const outside = (p: { x: number; y: number }) => !(p.x > E0 && p.x < E0 + 20 && p.y > N0 && p.y < N0 + 10);
    const ras = syntheticRaster(E0 - 10, N0 - 10, 80, 60, 0.5, (p) => (outside(p) ? CODE['depth-0-0.1'] : 0));
    const doors = [candidate({ expressId: 1, name: 'Fenster', category: 'window', position: { x: E0 + 10, y: N0 }, level: 501.5 }), candidate({ expressId: 2, position: { x: E0 + 5, y: N0 + 10 }, level: 500 })];
    const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
    const complete = boxFacts(doors);
    expect(checkFloodExposure(complete, ras, flatTerrain(500), opts).results[0].outcome).toBe('above-mapped-class-range');
    const partial = boxFacts(doors, { footprint: { ...complete.footprint, partial: true } });
    const r = checkFloodExposure(partial, ras, flatTerrain(500), opts).results[0];
    expect(r.outcome).toBe('within-class-range');
    expect(r.favourableWithheldBecause.join(' ')).toMatch(/footprint may miss part of the building/);
  });
});

describe('item 15: outline terrain samples, on a slope and for a long outline', () => {
  it('a long outline is sampled in at most 400 points (plus one per side)', async () => {
    const { outlineTerrainPoints, resolveSampling } = await import('../src/check/sampling.js');
    const { prepareFootprint } = await import('../src/region.js');
    const { E0, N0 } = await import('./helpers.js');
    const ring = [{ x: E0, y: N0 }, { x: E0 + 5000, y: N0 }, { x: E0 + 5000, y: N0 + 20 }, { x: E0, y: N0 + 20 }];
    const pts = outlineTerrainPoints(prepareFootprint({ rings: [ring], source: 'given' }), resolveSampling());
    expect(pts.length).toBeLessThanOrEqual(404);
    expect(pts.length).toBeGreaterThan(380);
  });

  it('on a slope the band spans the uphill and the downhill side: a ground storey at the uphill terrain passes, one above it by more than the band is refused', async () => {
    const { checkFloodExposure } = await import('../src/check/check.js');
    const { FloodCheckRefusal } = await import('../src/errors.js');
    const { boxFacts, candidate, CODE, CONFIRMED, E0, flatTerrain, N0, NO_OTHER_BUILDINGS, syntheticRaster } = await import('./helpers.js');
    // A 100 m long building on terrain rising 10 m from west to east; the doors on the east (uphill) end.
    const ring = [{ x: E0, y: N0 }, { x: E0 + 100, y: N0 }, { x: E0 + 100, y: N0 + 20 }, { x: E0, y: N0 + 20 }];
    const slope = { ...flatTerrain(500), heightAt: (p: { x: number }) => 500 + 0.1 * (p.x - E0) };
    const ras = syntheticRaster(E0 - 20, N0 - 20, 280, 120, 0.5, () => CODE['depth-0-0.1']);
    const facts = (g: number) => boxFacts([candidate({ position: { x: E0 + 95, y: N0 }, level: g })], {
      footprint: { rings: [ring], source: 'given', fromElements: [] },
      groundStorey: { expressId: 10, level: g, basis: 'given' },
      storeys: [{ expressId: 10, globalId: 's10', name: 'EG', level: g }],
    });
    const opts = { renderingConfirmation: CONFIRMED, otherBuildings: NO_OTHER_BUILDINGS };
    const ok = checkFloodExposure(facts(509.5), ras, slope, opts).heightPlausibility;
    expect(ok.status).toBe('within-band');
    expect(ok.terrainMin!).toBeLessThan(500.5);
    expect(ok.terrainMax!).toBeGreaterThan(509.5);
    expect(() => checkFloodExposure(facts(514), ras, slope, opts)).toThrow(FloodCheckRefusal);
  });
});

describe('item 4: a clipped body bottom equal to the placement level is still a lower bound', () => {
  it('a light well placed at its clipped body\'s bottom is labelled a lower bound, not exact', async () => {
    const facts = await extract((b) => {
      const first = b.rectExtrusion(0, 0, 1, 1, 1, b.axis(0, 0, 0), b.dir(0, 0, 1)); // z 0..1 in its own frame: bottom at the placement
      const cut = b.rectExtrusion(0, 0, 2, 2, 0.5, b.axis(0, 0, -0.1), b.dir(0, 0, 1)); // may have removed the bottom
      const body = b.add(`IFCBOOLEANRESULT(.DIFFERENCE.,#${first},#${cut})`);
      b.contain(b.storeys.eg.id, b.add(`IFCBUILDINGELEMENTPROXY(${b.guid()},$,'Lichtschacht Ost',$,$,#${b.place(b.storeys.eg.pl, 21, 5, 0)},#${b.shape([body])},$,.ELEMENT.)`));
      b.contain(b.storeys.eg.id, b.add(`IFCSLAB(${b.guid()},$,'Platte',$,$,#${b.place(b.storeys.eg.pl, 0, 0, 0)},#${b.shape([b.rectExtrusion(10, 5, 20, 10, 0.3, b.axis(0, 0, 0), b.dir(0, 0, -1))])},$,.FLOOR.)`));
    });
    expect(facts.candidates.find((c) => c.name === 'Lichtschacht Ost')).toMatchObject({ levelIsLowerBound: true });
  });
});

describe('item 11: with no footprint, outside is unknown', () => {
  it('outsideBy answers null with no rings; the samples are then taken (nothing excludes them) and the footprint withholds', async () => {
    const { outsideBy, prepareFootprint } = await import('../src/region.js');
    const { planSamples, resolveSampling } = await import('../src/check/sampling.js');
    const { candidate, E0, N0 } = await import('./helpers.js');
    const empty = prepareFootprint({ rings: [], source: 'candidate-hull' });
    expect(outsideBy(empty, { x: E0, y: N0 }, 1)).toBeNull();
    expect(planSamples(candidate({ position: { x: E0, y: N0 }, level: 500 }), empty, resolveSampling()).points).toHaveLength(32);
  });
});
