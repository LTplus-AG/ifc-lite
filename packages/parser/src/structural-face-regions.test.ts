/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A face of several `IfcFaceOuterBound` loops, as AxisVM writes a structural slab (#9945): each loop
 * outside the others is a region, and the glyph reader keeps all of them. Expected positions are
 * worked out by hand from the coordinates below.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from './index.js';
import { faceRegionsOfOuterBounds } from './structural-face-regions.js';
import { ItemGeometryReader, type ItemShape, type Vec3 } from './structural-item-geometry.js';
import { onShape, shapeCentre, shapeStations } from './structural-glyph-stations.js';

const square = (x: number, y: number, size: number): Vec3[] => [[x, y, 0], [x + size, y, 0], [x + size, y + size, 0], [x, y + size, 0]];

describe('faceRegionsOfOuterBounds', () => {
  it('reads disjoint loops as separate regions, in file order', () => {
    const rings = [square(0, 0, 1), square(3, 0, 1), square(6, 0, 1)];
    expect(faceRegionsOfOuterBounds(rings)).toEqual(rings.map((polygon) => ({ polygon, innerBounds: [] })));
  });

  it('reads a loop inside another as its opening, the case of an opening tagged as an outer bound', () => {
    const outer = square(0, 0, 10);
    const opening = square(4, 4, 2);
    expect(faceRegionsOfOuterBounds([outer, opening])).toEqual([{ polygon: outer, innerBounds: [opening] }]);
    // The same whichever loop the file lists first.
    expect(faceRegionsOfOuterBounds([opening, outer])).toEqual([{ polygon: outer, innerBounds: [opening] }]);
  });

  it('reads a loop inside an opening as a region again, and leaves a disjoint loop alone', () => {
    const outer = square(0, 0, 10);
    const opening = square(2, 2, 6);
    const island = square(4, 4, 2);
    const apart = square(20, 0, 1);
    expect(faceRegionsOfOuterBounds([outer, opening, island, apart])).toEqual([
      { polygon: outer, innerBounds: [opening] }, { polygon: island, innerBounds: [] }, { polygon: apart, innerBounds: [] },
    ]);
  });

  it('keeps a tile that fills the notch of a concave loop as its own region', () => {
    // An L whose notch is the square [2,4] x [2,4]; the tile below has all three vertices on the L's edges and lies outside it.
    const l: Vec3[] = [[0, 0, 0], [4, 0, 0], [4, 2, 0], [2, 2, 0], [2, 4, 0], [0, 4, 0]];
    const tile: Vec3[] = [[4, 2, 0], [2, 4, 0], [2, 2, 0]];
    expect(faceRegionsOfOuterBounds([l, tile])).toEqual([{ polygon: l, innerBounds: [] }, { polygon: tile, innerBounds: [] }]);
  });

  it('keeps a triangle that spans the notch of an L as a region although every vertex is on the L', () => {
    const l: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 4, 0], [4, 4, 0], [4, 10, 0], [0, 10, 0]];
    // Its edge (10,4)-(4,10) crosses the notch, so it leaves the L; its interior point (4.67, 4.67) is inside the L.
    const triangle: Vec3[] = [[0, 0, 0], [10, 4, 0], [4, 10, 0]];
    expect(faceRegionsOfOuterBounds([l, triangle])).toEqual([{ polygon: l, innerBounds: [] }, { polygon: triangle, innerBounds: [] }]);
  });

  it('keeps a rectangle around a thin slit whose ends touch its edges as a region', () => {
    // A square with a thin slit from the top down to (3.1, 2). The rectangle (1,2)-(9,9) has the slit's ends on its own
    // edges, so no vertex of the square is strictly inside it, yet the whole slit is: it is not inside the square.
    const square10: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [3.2, 10, 0], [3.2, 9, 0], [3.1, 2, 0], [3, 9, 0], [3, 10, 0], [0, 10, 0]];
    const rectangle: Vec3[] = [[1, 2, 0], [9, 2, 0], [9, 9, 0], [1, 9, 0]];
    expect(faceRegionsOfOuterBounds([square10, rectangle])).toEqual([{ polygon: square10, innerBounds: [] }, { polygon: rectangle, innerBounds: [] }]);
  });

  it('keeps a rectangle over a V-dip as a region although its edge runs exactly through the slot vertices', () => {
    // A 10 x 10 square with a slot from the top (x 3 to 3.2, down to y 2) ending in a V-dip to (3.1, 1). The rectangle
    // (1,0.5)-(9,2) has every vertex and edge midpoint in the square and only touches the slot's lower vertices, so
    // neither the crossing nor the midpoint test sees the dip; the dip's apex (3.1, 1) lies strictly inside the rectangle.
    const square10: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [3.2, 10, 0], [3.2, 2, 0], [3.1, 1, 0], [3, 2, 0], [3, 10, 0], [0, 10, 0]];
    const rectangle: Vec3[] = [[1, 0.5, 0], [9, 0.5, 0], [9, 2, 0], [1, 2, 0]];
    expect(faceRegionsOfOuterBounds([square10, rectangle])).toEqual([{ polygon: square10, innerBounds: [] }, { polygon: rectangle, innerBounds: [] }]);
  });

  it('keeps a tile whose edge cuts across a thin notch off its midpoint as a region', () => {
    // A square with a thin slot cut in from the top at x = 3..3.2; the tile's long edge from (0,0) to
    // (10,9) passes through the slot while its midpoint (5,4.5) and endpoints lie in the square.
    const slotted: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [3.2, 10, 0], [3.2, 2, 0], [3, 2, 0], [3, 10, 0], [0, 10, 0]];
    const tile: Vec3[] = [[0, 0, 0], [10, 9, 0], [10, 0.5, 0]];
    expect(faceRegionsOfOuterBounds([slotted, tile])).toEqual([{ polygon: slotted, innerBounds: [] }, { polygon: tile, innerBounds: [] }]);
  });

  it('reads a loop whose first vertex is repeated, and keeps a tiny loop as a region', () => {
    const repeated: Vec3[] = [[0, 0, 0], [0, 0, 0], [2, 0, 0], [0, 2, 0]];
    const apart = square(10, 0, 1);
    expect(faceRegionsOfOuterBounds([repeated, apart])).toEqual([{ polygon: repeated, innerBounds: [] }, { polygon: apart, innerBounds: [] }]);
    // 0.5 micrometre square in metres: an area of 2.5e-13, far below any absolute cut-off, beside a 10 m loop.
    const tiny: Vec3[] = [[20, 0, 0], [20.0000005, 0, 0], [20.0000005, 0.0000005, 0], [20, 0.0000005, 0]];
    expect(faceRegionsOfOuterBounds([square(0, 0, 10), tiny])).toEqual([{ polygon: square(0, 0, 10), innerBounds: [] }, { polygon: tiny, innerBounds: [] }]);
  });

  it('reads loops in different planes as no regions of one face', () => {
    const wall: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]];
    const floorPatch: Vec3[] = [[4, 0, 4], [6, 0, 4], [6, 2, 4], [4, 2, 4]]; // projects inside the wall loop but lies in another plane
    expect(faceRegionsOfOuterBounds([wall, floorPatch])).toBeNull();
  });

  it('reads an L-shaped opening whose vertex average falls in the notch of the larger L as that L\'s opening', () => {
    const big: Vec3[] = [[0, 0, 0], [10, 0, 0], [10, 4, 0], [4, 4, 0], [4, 10, 0], [0, 10, 0]];
    // Follows the big L's two arms, so the average of its vertices (4.33, 4.33) lies in the notch (x > 4, y > 4).
    const opening: Vec3[] = [[1, 1, 0], [9, 1, 0], [9, 3, 0], [3, 3, 0], [3, 9, 0], [1, 9, 0]];
    expect(faceRegionsOfOuterBounds([big, opening])).toEqual([{ polygon: big, innerBounds: [opening] }]);
  });

  it('drops a collinear loop, which bounds nothing, and keeps a single loop as one', () => {
    const line: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    expect(faceRegionsOfOuterBounds([line, square(5, 5, 1)])).toEqual([{ polygon: square(5, 5, 1), innerBounds: [] }]);
    expect(faceRegionsOfOuterBounds([square(0, 0, 1)])).toHaveLength(1);
    expect(faceRegionsOfOuterBounds([line, line])).toBeNull();
  });
});

describe('a face of disjoint outer-bound loops is drawn on all its regions', () => {
  const shape: ItemShape = { kind: 'face', polygon: square(0, 0, 2), regions: [{ polygon: square(10, 0, 2), innerBounds: [] }] };

  it('lies on either region and not between them', () => {
    expect(onShape(shape, [1, 1, 0])).toBe(true);
    expect(onShape(shape, [11, 1, 0])).toBe(true);
    expect(onShape(shape, [6, 1, 0])).toBe(false);
    expect(onShape({ kind: 'face', polygon: square(0, 0, 2) }, [11, 1, 0])).toBe(false);
  });

  it('gives each far-apart region a station of its own, none in the gap', () => {
    const stations = shapeStations(shape);
    expect(stations.some((p) => p[0] < 2)).toBe(true);
    expect(stations.some((p) => p[0] >= 10)).toBe(true);
    expect(stations.every((p) => onShape(shape, p))).toBe(true);
    expect(onShape(shape, shapeCentre(shape))).toBe(true);
    // Without the second region only the first is drawn on.
    expect(shapeStations({ kind: 'face', polygon: square(0, 0, 2) }).every((p) => p[0] < 2)).toBe(true);
  });

  it('spreads the lattice of a slab tiled by two triangles over both', () => {
    // A 4 x 4 square split along its diagonal, the way a slab is triangulated.
    const lower: Vec3[] = [[0, 0, 0], [4, 0, 0], [0, 4, 0]];
    const upper: Vec3[] = [[4, 0, 0], [4, 4, 0], [0, 4, 0]];
    const tiled: ItemShape = { kind: 'face', polygon: lower, regions: [{ polygon: upper, innerBounds: [] }] };
    const stations = shapeStations(tiled);
    expect(stations).toHaveLength(9);
    expect(stations.some((p) => p[0] + p[1] < 4 - 1e-6)).toBe(true);
    expect(stations.some((p) => p[0] + p[1] > 4 + 1e-6)).toBe(true);
    expect(stations.every((p) => onShape(tiled, p))).toBe(true);
    // Without the second region only the lower triangle's points remain.
    expect(shapeStations({ kind: 'face', polygon: lower }).every((p) => p[0] + p[1] <= 4 + 1e-6)).toBe(true);
    expect(shapeStations({ kind: 'face', polygon: lower }).length).toBeLessThan(9);
  });
});

describe('the item reader keeps the regions of an IfcFaceSurface (#9945)', () => {
  const STEP = `ISO-10303-21;HEADER;FILE_DESCRIPTION((''),'2;1');FILE_NAME('x.ifc','',(''),(''),'','','');FILE_SCHEMA(('IFC2X3'));ENDSEC;DATA;
#1=IFCPROJECT('0Project0000000000000a',$,'P',$,$,$,(#3),#2);
#2=IFCUNITASSIGNMENT((#4));
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCCARTESIANPOINT((0.,0.,0.));
#31=IFCCARTESIANPOINT((2.,0.,0.));
#32=IFCCARTESIANPOINT((0.,2.,0.));
#33=IFCCARTESIANPOINT((10.,0.,0.));
#34=IFCCARTESIANPOINT((12.,0.,0.));
#35=IFCCARTESIANPOINT((10.,2.,0.));
#36=IFCPOLYLOOP((#30,#31,#32));
#37=IFCPOLYLOOP((#33,#34,#35));
#38=IFCFACEOUTERBOUND(#36,.T.);
#39=IFCFACEOUTERBOUND(#37,.T.);
#40=IFCFACE((#38,#39));
#41=IFCTOPOLOGYREPRESENTATION(#3,'Reference','Face',(#40));
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#43=IFCSTRUCTURALSURFACEMEMBER('0Slab000000000000000a',$,'Slab',$,$,#20,#42,.SHELL.,0.2);
ENDSEC;END-ISO-10303-21;`;

  it('drops a degenerate loop first in the file instead of letting it decide the face frame', async () => {
    const withSliver = STEP.replace('#36=IFCPOLYLOOP((#30,#31,#32));', '#36=IFCPOLYLOOP((#30,#31,#31));').replace('#37=IFCPOLYLOOP((#33,#34,#35));', '#37=IFCPOLYLOOP((#33,#34,#35));');
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(withSliver).buffer as ArrayBuffer);
    const shape = new ItemGeometryReader(store).shape(43);
    expect(shape?.kind).toBe('face');
    if (shape?.kind !== 'face') return;
    expect(shape.polygon).toEqual([[10, 0, 0], [12, 0, 0], [10, 2, 0]]);
    expect(shape.regions).toBeUndefined();
    expect(onShape(shape, [10.5, 0.5, 0])).toBe(true);
  });

  it('reads loops that share no plane as before: the first outer bound with the rest as openings', async () => {
    const skew = STEP.replace('#35=IFCCARTESIANPOINT((10.,2.,0.));', '#35=IFCCARTESIANPOINT((10.,2.,5.));');
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(skew).buffer as ArrayBuffer);
    const shape = new ItemGeometryReader(store).shape(43);
    expect(shape?.kind).toBe('face');
    if (shape?.kind !== 'face') return;
    expect(shape.regions).toBeUndefined();
    expect(shape.polygon).toEqual([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
    expect(shape.innerBounds).toEqual([[[10, 0, 0], [12, 0, 0], [10, 2, 5]]]);
  });

  it('returns the first triangle as the polygon and the second as a further region', async () => {
    const store = await new IfcParser().parseColumnar(new TextEncoder().encode(STEP).buffer as ArrayBuffer);
    const shape = new ItemGeometryReader(store).shape(43);
    expect(shape?.kind).toBe('face');
    if (shape?.kind !== 'face') return;
    expect(shape.polygon).toEqual([[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
    expect(shape.regions).toEqual([{ polygon: [[10, 0, 0], [12, 0, 0], [10, 2, 0]], innerBounds: [] }]);
    // A point load on the second triangle is on the face; between the triangles it is not.
    expect(onShape(shape, [10.5, 0.5, 0])).toBe(true);
    expect(onShape(shape, [6, 0.5, 0])).toBe(false);
  });
});
