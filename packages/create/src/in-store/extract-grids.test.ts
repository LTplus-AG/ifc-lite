/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `extractGridAxesForStorey` (#6232 D3): the design-grid axes a storey shows,
 * in storey-local metres, from a FILE (a millimetre model, the grid contained
 * in the building above the storey, placed turned, one axis a polyline and one
 * an IfcTrimmedCurve over an IfcLine) and from grids AUTHORED this session
 * (`addGridToStore`), through the same overlay-aware reader.
 */

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { addGridToStore, rectangularGridAxes } from './grid.js';
import { extractGridAxesForStorey } from './extract-grids.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';

const parse = async (text: string) => new IfcParser().parseColumnar(
  new TextEncoder().encode(text).buffer as ArrayBuffer,
  { disableWorkerScan: true },
);

/**
 * A millimetre model: building #40, storey #50 at (1000, 2000) mm, and a grid
 * contained in the BUILDING (not the storey), placed at (500, 0) and turned 90°
 * (its X runs along storey +Y). Axis '1' is a polyline (0,0)->(0,8000) in the
 * grid's frame; axis 'A' an IfcTrimmedCurve over the line through (0,3000)
 * along +X, trimmed by parameters 0 and 6000.
 */
const FILE_GRID = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvctVUKr0kugbFTf53O9L',$,'P',$,$,$,$,(#20),#30);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#40=IFCBUILDING('1hQBAVPOr5VxhS3Jl0O47h',$,'B',$,$,#45,$,$,.ELEMENT.,$,$,$);
#45=IFCLOCALPLACEMENT($,#46);
#46=IFCAXIS2PLACEMENT3D(#47,$,$);
#47=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCBUILDINGSTOREY('2hQBAVPOr5VxhS3Jl0O47h',$,'L0',$,$,#51,$,$,.ELEMENT.,0.);
#51=IFCLOCALPLACEMENT(#45,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT((1000.,2000.,0.));
#60=IFCLOCALPLACEMENT(#51,#61);
#61=IFCAXIS2PLACEMENT3D(#62,$,#63);
#62=IFCCARTESIANPOINT((500.,0.,0.));
#63=IFCDIRECTION((0.,1.,0.));
#70=IFCCARTESIANPOINT((0.,0.));
#71=IFCCARTESIANPOINT((0.,8000.));
#72=IFCPOLYLINE((#70,#71));
#73=IFCGRIDAXIS('1',#72,.T.);
#74=IFCCARTESIANPOINT((0.,3000.));
#75=IFCDIRECTION((1.,0.));
#76=IFCVECTOR(#75,1.);
#77=IFCLINE(#74,#76);
#78=IFCTRIMMEDCURVE(#77,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(6000.)),.T.,.PARAMETER.);
#79=IFCGRIDAXIS('A',#78,.T.);
#80=IFCGRID('3hQBAVPOr5VxhS3Jl0O47h',$,'Grid',$,$,#60,$,(#73),(#79),$,.RECTANGULAR.);
#90=IFCRELAGGREGATES('4hQBAVPOr5VxhS3Jl0O47h',$,$,$,#1,(#40));
#91=IFCRELAGGREGATES('5hQBAVPOr5VxhS3Jl0O47h',$,$,$,#40,(#50));
#92=IFCRELCONTAINEDINSPATIALSTRUCTURE('6hQBAVPOr5VxhS3Jl0O47h',$,$,$,(#80),#40);
ENDSEC;
END-ISO-10303-21;
`;

const round = (p: readonly number[]) => p.map((v) => Math.round(v * 1e6) / 1e6);

describe('extractGridAxesForStorey: a file grid (#6232 D3)', () => {
  it("reads a building-level grid's axes in storey-local metres through its turned placement", async () => {
    const store = await parse(FILE_GRID);
    const { axes, gridIds, skippedAxes } = extractGridAxesForStorey(store, 50);
    expect(gridIds).toEqual([80]);
    expect(skippedAxes).toBe(0);
    const byTag = new Map(axes.map((a) => [a.tag, a]));
    // Grid-frame (0,0)->(0,8) m at grid origin (0.5, 0) turned 90°: X -> +Y, Y -> -X.
    expect(round(byTag.get('1')!.a)).toEqual([0.5, 0]);
    expect(round(byTag.get('1')!.b)).toEqual([-7.5, 0]);
    expect(byTag.get('1')!.family).toBe('U');
    // The trimmed line (0,3)->(6,0..) in the grid frame: (-2.5, 0) -> (-2.5, 6).
    expect(round(byTag.get('A')!.a)).toEqual([-2.5, 0]);
    expect(round(byTag.get('A')!.b)).toEqual([-2.5, 6]);
    expect(byTag.get('A')!.family).toBe('V');
  });

  it('offers nothing for a storey with no grid above or on it', async () => {
    const store = await parse(FILE_GRID.replace('#92=IFCRELCONTAINEDINSPATIALSTRUCTURE(\'6hQBAVPOr5VxhS3Jl0O47h\',$,$,$,(#80),#40);', ''));
    expect(extractGridAxesForStorey(store, 50).axes).toEqual([]);
  });
});

describe('extractGridAxesForStorey: an authored grid (#6232 D3)', () => {
  const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

  async function session() {
    const bytes = await readFile(SAMPLE);
    const store = await new IfcParser().parseColumnar(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      { disableWorkerScan: true },
    );
    const view = new MutablePropertyView(null, 'm');
    const editor = new StoreEditor(store, view);
    return { store, view, editor, anchor: resolveSpatialAnchor(store, 42, view) };
  }

  it('finds the axes addGridToStore wrote, tagged, at the grid position, and drops them with the grid', async () => {
    const { store, view, editor, anchor } = await session();
    expect(extractGridAxesForStorey(store, 42, view).axes).toEqual([]);
    const grid = addGridToStore(editor, anchor, {
      Position: [2, 3, 0],
      ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4, 8], Overhang: 1 }),
    });
    const { axes, gridIds } = extractGridAxesForStorey(store, 42, view);
    expect(gridIds).toEqual([grid.gridId]);
    expect(axes.map((a) => `${a.family}${a.tag}`)).toEqual(['U1', 'U2', 'VA', 'VB', 'VC']);
    // U axis '2' is the line x = 6 in the grid frame, y from -1 to 9: storey-local (8, 2) -> (8, 12).
    const u2 = axes.find((a) => a.tag === '2')!;
    expect(round(u2.a)).toEqual([8, 2]);
    expect(round(u2.b)).toEqual([8, 12]);
    const vc = axes.find((a) => a.tag === 'C')!;
    expect(round(vc.a)).toEqual([1, 11]);
    expect(round(vc.b)).toEqual([9, 11]);

    editor.removeEntity(grid.gridId);
    expect(extractGridAxesForStorey(store, 42, view).axes).toEqual([]);
  });
});
