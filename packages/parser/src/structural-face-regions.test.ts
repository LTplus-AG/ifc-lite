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

  it('keeps every loop of a non-planar or degenerate face as its own region', () => {
    const line: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    expect(faceRegionsOfOuterBounds([line, square(5, 5, 1)])).toHaveLength(2);
    expect(faceRegionsOfOuterBounds([square(0, 0, 1)])).toHaveLength(1);
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

  it('keeps every station of a far-apart pair on the face, with none in the gap', () => {
    const stations = shapeStations(shape);
    expect(stations.length).toBeGreaterThan(0);
    expect(stations.every((p) => onShape(shape, p))).toBe(true);
    expect(onShape(shape, shapeCentre(shape))).toBe(true);
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
