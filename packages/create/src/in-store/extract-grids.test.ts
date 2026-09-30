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
    const byTag = new Map(axes.map((a) => [a.AxisTag, a]));
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

  it('skips a bent polyline axis instead of inventing a straight snap line (#6511 review)', async () => {
    const bent = FILE_GRID.replace('#72=IFCPOLYLINE((#70,#71));', '#69=IFCCARTESIANPOINT((3000.,4000.));\n#72=IFCPOLYLINE((#70,#69,#71));')
      .replace('.RECTANGULAR.', '.IRREGULAR.');
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(bent), 50);
    expect(axes.map((axis) => axis.AxisTag)).toEqual(['A']);
    expect(skippedAxes).toBe(1);
  });

  it('keeps a straight polyline with an intermediate collinear point (#6511 review)', async () => {
    const straight = FILE_GRID.replace('#72=IFCPOLYLINE((#70,#71));', '#69=IFCCARTESIANPOINT((0.,4000.));\n#72=IFCPOLYLINE((#70,#69,#71));');
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(straight), 50);
    expect(skippedAxes).toBe(0);
    const axis = axes.find((item) => item.AxisTag === '1');
    expect(axis).toBeDefined();
    if (!axis) throw new Error('Expected the straight axis');
    expect(round(axis.a)).toEqual([0.5, 0]);
    expect(round(axis.b)).toEqual([-7.5, 0]);
  });

  it('skips an axis that extends beyond its endpoint before backtracking (#6511 review)', async () => {
    const backtracking = FILE_GRID.replace('#72=IFCPOLYLINE((#70,#71));', '#69=IFCCARTESIANPOINT((0.,12000.));\n#72=IFCPOLYLINE((#70,#69,#71));')
      .replace('.RECTANGULAR.', '.IRREGULAR.');
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(backtracking), 50);
    expect(axes.map((axis) => axis.AxisTag)).toEqual(['A']);
    expect(skippedAxes).toBe(1);
  });
});

describe('trimmed grid lines require a readable typed basis (#6511 / #6232)', () => {
  const malformed = [
    ['missing magnitude', '#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,$);'],
    ['nonfinite magnitude', '#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,1.E309);'],
    ['zero magnitude', '#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,0.);'],
    ['negative magnitude', '#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,-1.);'],
    ['wrong vector class', '#76=IFCVECTOR(#75,1.);', '#76=IFCDIRECTION(#75,1.);'],
    ['wrong orientation class', '#75=IFCDIRECTION((1.,0.));', '#75=IFCCARTESIANPOINT((1.,0.));'],
    ['missing orientation', '#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#999999,1.);'],
    ['zero orientation', '#75=IFCDIRECTION((1.,0.));', '#75=IFCDIRECTION((0.,0.));'],
    ['nonfinite orientation', '#75=IFCDIRECTION((1.,0.));', '#75=IFCDIRECTION((1.E309,0.));'],
    ['wrong orientation dimension', '#75=IFCDIRECTION((1.,0.));', '#75=IFCDIRECTION((1.,0.,1.));'],
    ['wrong origin dimension', '#74=IFCCARTESIANPOINT((0.,3000.));', '#74=IFCCARTESIANPOINT((0.,3000.,1.));'],
  ] as const;

  function pointTrims(text: string): string {
    return text.replace('#78=IFCTRIMMEDCURVE(#77,(IFCPARAMETERVALUE(0.)),(IFCPARAMETERVALUE(6000.)),.T.,.PARAMETER.);',
      '#81=IFCCARTESIANPOINT((6000.,3000.));\n#78=IFCTRIMMEDCURVE(#77,(#74),(#81),.T.,.CARTESIAN.);');
  }

  for (const trims of ['parameter', 'point'] as const) {
    it.each(malformed)(`${trims} trims refuse %s without dropping the valid U axis`, async (_label, before, after) => {
      const text = (trims === 'point' ? pointTrims(FILE_GRID) : FILE_GRID).replace(before, after);
      const { axes, skippedAxes } = extractGridAxesForStorey(await parse(text), 50);
      expect(axes.map((axis) => axis.AxisTag)).toEqual(['1']);
      expect(axes.map((axis) => [round(axis.a), round(axis.b)])).toEqual([[[0.5, 0], [-7.5, 0]]]);
      expect(skippedAxes).toBe(1);
    });
  }

  it.each(['4.', '1.E-310'])('parameter trims normalize legitimate 2D direction %s and apply vector magnitude once', async (ratio) => {
    const text = FILE_GRID.replace('#75=IFCDIRECTION((1.,0.));', `#75=IFCDIRECTION((${ratio},0.));`)
      .replace('#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,2.);');
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(text), 50);
    const axis = axes.find((item) => item.AxisTag === 'A');
    expect(axis).toBeDefined();
    expect([round(axis!.a), round(axis!.b)]).toEqual([[-2.5, 0], [-2.5, 12]]);
    expect(skippedAxes).toBe(0);
  });

  it.each([
    ['nonfinite trim parameter', FILE_GRID.replace('IFCPARAMETERVALUE(6000.)', 'IFCPARAMETERVALUE(1.E309)')],
    ['overflowed endpoint', FILE_GRID.replace('#76=IFCVECTOR(#75,1.);', '#76=IFCVECTOR(#75,1.E308);')],
  ])('refuses a %s instead of offering nonfinite snap coordinates', async (_label, text) => {
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(text), 50);
    expect(axes.map((axis) => axis.AxisTag)).toEqual(['1']);
    expect(skippedAxes).toBe(1);
  });

  it('point trims retain their authored endpoints with a valid 2D basis', async () => {
    const { axes, skippedAxes } = extractGridAxesForStorey(await parse(pointTrims(FILE_GRID)), 50);
    const axis = axes.find((item) => item.AxisTag === 'A');
    expect(axis).toBeDefined();
    expect([round(axis!.a), round(axis!.b)]).toEqual([[-2.5, 0], [-2.5, 6]]);
    expect(skippedAxes).toBe(0);
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
    expect(axes.map((a) => `${a.family}${a.AxisTag}`)).toEqual(['U1', 'U2', 'VA', 'VB', 'VC']);
    // U axis '2' is the line x = 6 in the grid frame, y from -1 to 9: storey-local (8, 2) -> (8, 12).
    const u2 = axes.find((a) => a.AxisTag === '2')!;
    expect(round(u2.a)).toEqual([8, 2]);
    expect(round(u2.b)).toEqual([8, 12]);
    const vc = axes.find((a) => a.AxisTag === 'C')!;
    expect(round(vc.a)).toEqual([1, 11]);
    expect(round(vc.b)).toEqual([9, 11]);

    editor.removeEntity(grid.gridId);
    expect(extractGridAxesForStorey(store, 42, view).axes).toEqual([]);
  });
});


describe('grid placement orientation refuses unreadable frames (#6511 / #6232)', () => {
  const malformed = [
    ['missing RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#999999);'],
    ['zero RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCDIRECTION((0.,0.,0.));'],
    ['incomplete RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCDIRECTION((0.,1.));'],
    ['oversized RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCDIRECTION((0.,1.,0.,0.));'],
    ['wrong RefDirection class', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCCARTESIANPOINT((0.,1.,0.));'],
    ['nonfinite RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCDIRECTION((0.,1.E309,0.));'],
    ['parallel RefDirection', '#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', '#63=IFCDIRECTION((0.,0.,1.));'],
    ['missing Axis', '#61=IFCAXIS2PLACEMENT3D(#62,#999999,#63);'],
    ['zero Axis', '#61=IFCAXIS2PLACEMENT3D(#62,#94,#63);', '#94=IFCDIRECTION((0.,0.,0.));'],
    ['incomplete Axis', '#61=IFCAXIS2PLACEMENT3D(#62,#94,#63);', '#94=IFCDIRECTION((0.,0.));'],
    ['nonplanar Axis', '#61=IFCAXIS2PLACEMENT3D(#62,#94,#63);', '#94=IFCDIRECTION((1.,0.,1.));'],
  ] as const;

  function altered(placement: string, direction?: string): string {
    let text = FILE_GRID.replace('#61=IFCAXIS2PLACEMENT3D(#62,$,#63);', placement);
    if (direction) text = direction.startsWith('#63=')
      ? text.replace('#63=IFCDIRECTION((0.,1.,0.));', direction)
      : text.replace('ENDSEC;\nEND-ISO-10303-21;', `${direction}\nENDSEC;\nEND-ISO-10303-21;`);
    return text;
  }

  it.each(malformed)('refuses explicit %s instead of inventing straight snap axes', async (_label, placement, direction?: string) => {
    const result = extractGridAxesForStorey(await parse(altered(placement, direction)), 50);
    expect(result.axes).toEqual([]);
    expect(result.skippedAxes).toBe(2);
  });

  it('omitted optional Axis and RefDirection retain the canonical default orientation', async () => {
    const axes = extractGridAxesForStorey(await parse(altered('#61=IFCAXIS2PLACEMENT3D(#62,$,$);')), 50).axes;
    expect(axes.map((axis) => [axis.AxisTag, round(axis.a), round(axis.b)])).toEqual([
      ['1', [0.5, 0], [0.5, 8]], ['A', [0.5, 3], [6.5, 3]],
    ]);
  });

  it('an unreadable intermediate placement cannot succeed with its partial child frame', async () => {
    const text = FILE_GRID.replace('#60=IFCLOCALPLACEMENT(#51,#61);', '#60=IFCLOCALPLACEMENT(#900,#61);')
      .replace('ENDSEC;\nEND-ISO-10303-21;', '#900=IFCLOCALPLACEMENT(#51,#901);\n#901=IFCAXIS2PLACEMENT3D(#22,$,#999999);\nENDSEC;\nEND-ISO-10303-21;');
    expect(extractGridAxesForStorey(await parse(text), 50).axes).toEqual([]);
  });

  it('an unreadable storey frame cannot succeed with coordinates in its parent frame', async () => {
    const text = FILE_GRID.replace('#60=IFCLOCALPLACEMENT(#51,#61);', '#60=IFCLOCALPLACEMENT(#45,#61);')
      .replace('#52=IFCAXIS2PLACEMENT3D(#53,$,$);', '#52=IFCAXIS2PLACEMENT3D(#53,$,#999999);');
    expect(extractGridAxesForStorey(await parse(text), 50).axes).toEqual([]);
  });

  it('live direction edits and deletion refuse the same source-backed placement, and clearing them restores its axes', async () => {
    const store = await parse(FILE_GRID);
    const view = new MutablePropertyView(null, 'm');
    const before = extractGridAxesForStorey(store, 50, view).axes;
    expect(before).toHaveLength(2);
    view.setPositionalAttribute(63, 0, [0, 1]);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual([]);
    view.removePositionalMutation(63, 0);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual(before);
    view.deleteEntity(63);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual([]);
    view.restoreFromTombstone(63);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual(before);
    view.setEntityType(63, 'IfcCartesianPoint', undefined, 'IfcDirection', true);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual([]);
    view.removeTypeMutation(63);
    expect(extractGridAxesForStorey(store, 50, view).axes).toEqual(before);
  });
});
