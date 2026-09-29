/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `existingSpaceFootprintsByStorey` returns RINGS in storey-local metres
 * (charter #6232 M4), which the Room tool needs to know where rooms already
 * are and which room a layout face is:
 *
 *  - a faceted space (AC20-FZK-Haus's rooms are triangulated face sets) is
 *    outlined, not returned as its unordered vertex cloud;
 *  - a space authored this session in a millimetre model is scaled like a
 *    parsed one (the in-store builders write native units), not left in mm.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { existingSpaceFootprintsByStorey, existingSpaceFootprintEntriesByStorey, facetedFootprint } from './space-footprints.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addSpaceToStore } from './space.js';

type P2 = [number, number];

/** An L-shaped plan, CCW: 4 × 4 with the 2 × 2 top-right corner cut out, 12 m². */
const L: P2[] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
/** Fan triangles of the L from its reflex corner (2, 2): each lies inside it. */
const L_TRIS: Array<[number, number, number]> = [[3, 4, 5], [3, 5, 0], [3, 0, 1], [3, 1, 2]];

/** The L as a closed triangulated prism, 0–3 m: floor (down), ceiling (up), sides. Indices 1-based. */
function lPrism(): { coords: string; tris: string } {
  const n = L.length;
  const pts = [...L.map(([x, y]) => [x, y, 0]), ...L.map(([x, y]) => [x, y, 3])];
  const tris: number[][] = [];
  for (const [a, b, c] of L_TRIS) {
    tris.push([n + a + 1, n + b + 1, n + c + 1]); // ceiling, CCW from above
    tris.push([a + 1, c + 1, b + 1]); // floor, reversed
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    tris.push([i + 1, j + 1, n + j + 1], [i + 1, n + j + 1, n + i + 1]);
  }
  const f = (v: number) => `${v}.`;
  return {
    coords: pts.map((p) => `(${p.map(f).join(',')})`).join(','),
    tris: tris.map((t) => `(${t.join(',')})`).join(','),
  };
}

function ifc(unit: string, body: string): string {
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PROJECT000000000000',$,'Proj',$,$,$,$,(#7),#8);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#9,$);
#9=IFCAXIS2PLACEMENT3D(#90,$,$);
#90=IFCCARTESIANPOINT((0.,0.,0.));
#8=IFCUNITASSIGNMENT((#81));
#81=IFCSIUNIT(*,.LENGTHUNIT.,${unit},.METRE.);
#2=IFCSITE('0SITE0000000000000000',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#91,$,$);
#91=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(#11,#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#93,$,$);
#93=IFCCARTESIANPOINT((0.,0.,0.));
#84=IFCRELAGGREGATES('0RELAGG0000000000003',$,$,$,#1,(#2));
#77=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#78=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
${body}
ENDSEC;
END-ISO-10303-21;
`;
}

/** A space on storey #4 whose body is a triangulated face set (AC20's shape). */
function facetedSpace(): string {
  const { coords, tris } = lPrism();
  return `#6=IFCSPACE('0SPACE000000000000000',$,'Room',$,$,#26,#66,$,.ELEMENT.,.INTERNAL.,$);
#26=IFCLOCALPLACEMENT(#10,#27);
#27=IFCAXIS2PLACEMENT3D(#96,$,$);
#96=IFCCARTESIANPOINT((10.,20.,0.));
#66=IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#67=IFCSHAPEREPRESENTATION(#7,'Body','Tessellation',(#68));
#68=IFCTRIANGULATEDFACESET(#69,$,.T.,(${tris}),$);
#69=IFCCARTESIANPOINTLIST3D((${coords}));
#80=IFCRELAGGREGATES('0RELAGG0000000000002',$,$,$,#4,(#6));`;
}

async function parse(text: string): Promise<IfcDataStore> {
  return await new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer);
}

function signedArea(ring: readonly P2[]): number {
  let a = 0;
  ring.forEach((p, i) => { const q = ring[(i + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; });
  return a / 2;
}

function inside(ring: readonly P2[], [x, y]: P2): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

describe('existing space footprints are rings (#6232 M4)', () => {
  it('outlines a faceted space: the L itself, CCW, not its vertex cloud', async () => {
    const store = await parse(ifc('$', facetedSpace()));
    const [entry] = existingSpaceFootprintEntriesByStorey(store).get(4)!;
    expect(entry.expressId).toBe(6);
    const ring = entry.footprint as P2[];
    expect(ring).toHaveLength(6);
    expect(signedArea(ring)).toBeCloseTo(12, 9);
    // The placement puts the L at (10, 20).
    const key = (p: readonly number[]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    expect(ring.map(key).sort()).toEqual(L.map(([x, y]) => key([x + 10, y + 20])).sort());
    expect(inside(ring, [11, 21]), 'a point in the L').toBe(true);
    expect(inside(ring, [13, 23]), 'a point in the cut-out corner').toBe(false);
  });

  it('outlines a faceted brep box and falls back to the hull for an open shell', () => {
    const quad = (z: number, up: boolean): [number, number, number][] => {
      const q: [number, number, number][] = [[0, 0, z], [5, 0, z], [5, 2, z], [0, 2, z]];
      return up ? q : q.reverse();
    };
    const box = facetedFootprint([quad(0, false), quad(3, true), [[0, 0, 0], [5, 0, 0], [5, 0, 3], [0, 0, 3]]]);
    expect(signedArea(box as P2[])).toBeCloseTo(10, 9);
    // Only walls, no floor or ceiling: nothing faces up, the hull stands in.
    const walls = facetedFootprint([[[0, 0, 0], [5, 0, 0], [5, 0, 3], [0, 0, 3]], [[5, 0, 0], [5, 2, 0], [5, 2, 3], [5, 0, 3]], [[0, 2, 0], [0, 0, 0], [0, 0, 3], [0, 2, 3]]]);
    expect(signedArea(walls as P2[])).toBeCloseTo(10, 9);
  });

  it('scales a space authored this session in a millimetre model to metres, like a parsed one', async () => {
    const store = await parse(ifc('.MILLI.', ''));
    const view = new MutablePropertyView(store.properties ?? null, 'm');
    const editor = new StoreEditor(store, view);
    const anchor = resolveSpatialAnchor(store, 4, view)!;
    expect(anchor.lengthUnitScale).toBeCloseTo(0.001, 12);
    addSpaceToStore(editor, anchor, { Profile: 'polygon', OuterCurve: L, Position: [10, 10, 0], Height: 3 });
    const [ring] = existingSpaceFootprintsByStorey(store, view).get(4)!;
    const key = (p: readonly number[]) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
    expect(ring.map(key).sort()).toEqual(L.map(([x, y]) => key([x + 10, y + 10])).sort());
  });
});
