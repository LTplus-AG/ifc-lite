/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { generateLod0 } from './lod0-generator.js';

const IFC_WITH_BOUNDING_BOX = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('lod0.ifc','2026-05-27T00:00:00',$,$,'ifc-lite','ifc-lite',$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCLOCALPLACEMENT($,#11);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((10.,20.,30.));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','BoundingBox',(#32));
#32=IFCBOUNDINGBOX(#20,2.,3.,4.);
#40=IFCWALL('wall-guid',$,'Wall; with semicolon',$,$,#10,#30,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;

// #2032's sibling: `findAttrIndex` used the IFC4-pinned registry, so an
// IFC4X3-only leaf resolved zero attributes, `ObjectPlacement` came back
// null, and the walk's `continue` dropped the element from the export
// entirely — silently, with no skip reason recorded anywhere.
const IFC4X3_SIGNAL = IFC_WITH_BOUNDING_BOX
  .replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC4X3'))")
  .replace(
    "#40=IFCWALL('wall-guid',$,'Wall; with semicolon',$,$,#10,#30,$,.NOTDEFINED.);",
    "#40=IFCSIGNAL('signal-guid',$,'Signal',$,$,#10,#30,$,$);",
  );

describe('generateLod0', () => {
  it('uses the shared IFC scanner and preserves quoted semicolons in element names', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_WITH_BOUNDING_BOX));

    expect(lod0.elements).toHaveLength(1);
    expect(lod0.elements[0]).toMatchObject({
      expressID: 40,
      globalId: 'wall-guid',
      ifcClass: 'IFCWALL',
      name: 'Wall; with semicolon',
      bbox_source: 'shape',
    });
    expect(lod0.elements[0].bbox).toEqual({
      min: [10, 20, 30],
      max: [12, 23, 34],
    });
  });
  it('includes an IFC4X3-only element rather than silently dropping it (#2032 sibling)', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC4X3_SIGNAL));

    expect(lod0.elements).toHaveLength(1);
    expect(lod0.elements[0]).toMatchObject({
      expressID: 40,
      globalId: 'signal-guid',
      ifcClass: 'IFCSIGNAL',
    });
  });
});

/**
 * Every fixture above is METRE-scaled with its bounding-box corner at the local
 * origin — two constants that make the unit multiply and the corner offset
 * IDENTITIES. A mutation sweep confirmed it: deleting `* unitScale` from the
 * coordinate reader and from `IfcBoundingBox.XDim`, and discarding
 * `IfcBoundingBox.Corner` entirely, all left the suite green, as did emitting
 * the bbox min in place of the centroid, flipping the declared output unit to
 * `mm`, and growing the no-representation fallback cube fivefold.
 *
 * A millimetre model with an off-origin corner is the ordinary case in the
 * wild — Revit exports millimetres — and every one of those mutations puts an
 * element in the wrong place, or at 1000x its size, in the LOD0 output another
 * tool consumes.
 */
const IFC_MILLIMETRE = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');
FILE_NAME('lod0-mm.ifc','2026-05-27T00:00:00',$,$,'ifc-lite','ifc-lite',$);
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('project',$,'Project',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#10=IFCLOCALPLACEMENT($,#11);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((10000.,20000.,30000.));
#20=IFCCARTESIANPOINT((1000.,2000.,3000.));
#30=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#31=IFCSHAPEREPRESENTATION($,'Body','BoundingBox',(#32));
#32=IFCBOUNDINGBOX(#20,2000.,3000.,4000.);
#40=IFCWALL('wall-mm-guid',$,'MM Wall',$,$,#10,#30,$,.NOTDEFINED.);
#50=IFCWALL('no-shape-guid',$,'No Shape',$,$,#10,$,$,.NOTDEFINED.);
ENDSEC;
END-ISO-10303-21;`;

describe('generateLod0 — millimetre model with an off-origin bounding box', () => {
  it('applies the length-unit scale to placements, corners and dimensions alike', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_MILLIMETRE));
    const wall = lod0.elements.find((e) => e.globalId === 'wall-mm-guid')!;

    // placement (10,20,30) m + corner (1,2,3) m, dims (2,3,4) m.
    // Distinct per axis so a scale dropped on one axis is visible; corner
    // distinct from the placement so neither can stand in for the other.
    expect(wall.bbox.min.map((v) => Number(v.toFixed(6)))).toEqual([11, 22, 33]);
    expect(wall.bbox.max.map((v) => Number(v.toFixed(6)))).toEqual([13, 25, 37]);
    expect(wall.bbox_source).toBe('shape');
  });

  it('reports the centroid as the bbox midpoint, not a corner', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_MILLIMETRE));
    const wall = lod0.elements.find((e) => e.globalId === 'wall-mm-guid')!;
    // Asymmetric about the origin on every axis, so min/max/midpoint all differ.
    expect(wall.centroid.map((v) => Number(v.toFixed(6)))).toEqual([12, 23.5, 35]);
  });

  it('declares metres regardless of the source file unit', async () => {
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_MILLIMETRE));
    expect(lod0.units).toBe('m');
    expect(lod0.lod).toBe(0);
    expect(lod0.schema).toBe('ifc-lite-geometry');
  });

  it('falls back to a 0.2 m cube at the placement for an element with no representation', async () => {
    // The untested third state: `Representation` is `$`, so there is no shape
    // bbox to find and the fallback branch is the only thing that runs.
    const lod0 = await generateLod0(new TextEncoder().encode(IFC_MILLIMETRE));
    const bare = lod0.elements.find((e) => e.globalId === 'no-shape-guid')!;

    expect(bare.bbox_source).toBe('fallback');
    expect(bare.bbox.min.map((v) => Number(v.toFixed(6)))).toEqual([9.9, 19.9, 29.9]);
    expect(bare.bbox.max.map((v) => Number(v.toFixed(6)))).toEqual([10.1, 20.1, 30.1]);
  });
});
