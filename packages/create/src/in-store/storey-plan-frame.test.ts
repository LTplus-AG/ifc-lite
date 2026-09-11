/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `storeyPlanFrame` composes the storey's WHOLE placement chain, in metres, and
 * refuses rather than approximating when it cannot.
 *
 * It is the inverse of the contract `extractWallSegmentsForStorey` and
 * `existingSpaceFootprintsByStorey` already hold up from the other side: they
 * express geometry storey-locally because `addSpaceToStore` writes into a slot
 * anchored to the storey placement. A producer already working in the model's
 * world frame needs the same chain, composed the whole way, to get there.
 *
 * Every fixture here is non-commuting on purpose — a rotated site with a
 * rotated storey under it — because a chain that is a pure translation, or the
 * identity, cannot tell a double application from a single one.
 */

import { describe, it, expect } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { storeyPlanFrame, toStoreyLocal, fromStoreyLocal } from './storey-plan-frame.js';

/**
 * Site at (1000, 2000) turned 90°, building at the site origin, storey at
 * (100, 200) in the building turned by (0.6, 0.8). Composed:
 *   origin = (1000, 2000) + R_site·(100, 200) = (800, 2100)
 *   axisX  = R_site·(0.6, 0.8)                = (-0.8, 0.6)
 */
function fixture(opts: { unit?: string; storeyAxis?: string; breakChain?: boolean } = {}): string {
  const unit = opts.unit ?? '#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);';
  const storeyAxis = opts.storeyAxis ?? '$';
  const buildingRelTo = opts.breakChain ? '#999' : '#11';
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
${unit}
#2=IFCSITE('0SITE0000000000000000',$,'Site',$,$,#11,$,$,.ELEMENT.,$,$,$,$,$);
#11=IFCLOCALPLACEMENT($,#12);
#12=IFCAXIS2PLACEMENT3D(#91,$,#93);
#91=IFCCARTESIANPOINT((1000.,2000.,0.));
#93=IFCDIRECTION((0.,1.,0.));
#3=IFCBUILDING('0BUILDING000000000000',$,'Bldg',$,$,#13,$,$,.ELEMENT.,$,$,$);
#13=IFCLOCALPLACEMENT(${buildingRelTo},#14);
#14=IFCAXIS2PLACEMENT3D(#92,$,$);
#92=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);
#10=IFCLOCALPLACEMENT(#13,#15);
#15=IFCAXIS2PLACEMENT3D(#94,${storeyAxis},#95);
#94=IFCCARTESIANPOINT((100.,200.,0.));
#95=IFCDIRECTION((0.6,0.8,0.));
#96=IFCDIRECTION((0.,0.6,0.8));
#70=IFCRELAGGREGATES('0RELAGG0000000000000',$,$,$,#2,(#3));
#71=IFCRELAGGREGATES('0RELAGG0000000000001',$,$,$,#3,(#4));
ENDSEC;
END-ISO-10303-21;
`;
}

async function parse(ifc: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(ifc).buffer);
}

describe('storeyPlanFrame', () => {
  it('composes the whole chain, not just the storey placement', async () => {
    const frame = storeyPlanFrame(await parse(fixture()), 4);
    expect(frame).not.toBeNull();
    // Reading only the storey's own placement would give (100, 200): the site's
    // translation AND its rotation of that translation are both missing there.
    expect(frame!.origin[0]).toBeCloseTo(800, 9);
    expect(frame!.origin[1]).toBeCloseTo(2100, 9);
    expect(frame!.axisX[0]).toBeCloseTo(-0.8, 9);
    expect(frame!.axisX[1]).toBeCloseTo(0.6, 9);
  });

  it('scales the origin to metres from the file\'s own length unit', async () => {
    // Same numbers, declared as millimetres: the origin is a translation in
    // file units, so a mm model read as metres puts the storey 800 km out.
    const mm = '#81=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);';
    const frame = storeyPlanFrame(await parse(fixture({ unit: mm })), 4);
    expect(frame!.origin[0]).toBeCloseTo(0.8, 9);
    expect(frame!.origin[1]).toBeCloseTo(2.1, 9);
    // A direction is dimensionless — scaling it too would turn the storey.
    expect(frame!.axisX[0]).toBeCloseTo(-0.8, 9);
    expect(frame!.axisX[1]).toBeCloseTo(0.6, 9);
  });

  it('round-trips: fromStoreyLocal ∘ toStoreyLocal is the identity', async () => {
    const frame = storeyPlanFrame(await parse(fixture()), 4)!;
    for (const p of [[810, 2105], [0, 0], [-13.5, 7.25]] as Array<[number, number]>) {
      const back = fromStoreyLocal(frame, toStoreyLocal(frame, p));
      expect(back[0]).toBeCloseTo(p[0], 9);
      expect(back[1]).toBeCloseTo(p[1], 9);
    }
  });

  it('divides the chain out once — worked by hand, not by running it backwards', async () => {
    const frame = storeyPlanFrame(await parse(fixture()), 4)!;
    // Rᵀ·((810, 2105) − (800, 2100)) with R = [[-0.8, -0.6], [0.6, -0.8]].
    const local = toStoreyLocal(frame, [810, 2105]);
    expect(local[0]).toBeCloseTo(-5, 9);
    expect(local[1]).toBeCloseTo(-10, 9);
    // Applying it a SECOND time lands somewhere else entirely, which is what
    // makes the rotation in this fixture load-bearing.
    const twice = toStoreyLocal(frame, local);
    expect(twice[0]).not.toBeCloseTo(-5, 3);
  });

  it('refuses a storey with no ObjectPlacement', async () => {
    const noPlacement = fixture().replace(
      "#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,#10,$,$,.ELEMENT.,0.);",
      "#4=IFCBUILDINGSTOREY('0STOREY00000000000000',$,'Storey',$,$,$,$,$,.ELEMENT.,0.);",
    );
    expect(storeyPlanFrame(await parse(noPlacement), 4)).toBeNull();
  });

  it('refuses a chain with a link that will not read', async () => {
    // The building's PlacementRelTo points at nothing, so only part of the
    // chain can be composed — and a partial chain moves geometry by the wrong
    // amount rather than by none.
    expect(storeyPlanFrame(await parse(fixture({ breakChain: true })), 4)).toBeNull();
  });

  it('refuses a storey whose axis tips out of plan', async () => {
    // #96 is (0, 0.6, 0.8) — a storey tilted out of the ground plane has no
    // honest planar inverse, and projecting it would author a turned room.
    expect(storeyPlanFrame(await parse(fixture({ storeyAxis: '#96' })), 4)).toBeNull();
  });

  it('accepts an axis that is explicitly +Z', async () => {
    const upright = fixture({ storeyAxis: '#97' }).replace(
      '#96=IFCDIRECTION((0.,0.6,0.8));',
      '#96=IFCDIRECTION((0.,0.6,0.8));\n#97=IFCDIRECTION((0.,0.,1.));',
    );
    expect(storeyPlanFrame(await parse(upright), 4)).not.toBeNull();
  });

  it('refuses an unknown storey id rather than reporting the identity', async () => {
    expect(storeyPlanFrame(await parse(fixture()), 999)).toBeNull();
  });
});
