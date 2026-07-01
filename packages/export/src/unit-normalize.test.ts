/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import {
  toStepRealScaled,
  scaleNumberLiterals,
  scaleTypedMeasures,
  rescaleEntityLengths,
  getEntityLengthPlan,
  computeNormalizeFactor,
} from './unit-normalize.js';

describe('toStepRealScaled', () => {
  it('always emits a decimal point', () => {
    expect(toStepRealScaled(3)).toBe('3.');
    expect(toStepRealScaled(2500 * 0.001)).toBe('2.5');
  });

  it('erases floating-point noise from the multiply', () => {
    // 0.3048 * 100 = 30.479999999999997 in IEEE-754.
    expect(toStepRealScaled(0.3048 * 100)).toBe('30.48');
    expect(toStepRealScaled(1.1 * 3)).toBe('3.3');
  });

  it('emits valid STEP exponent form for tiny/huge magnitudes (uppercase E, mantissa dot)', () => {
    expect(toStepRealScaled(5e-7)).toBe('5.E-7');
    expect(toStepRealScaled(1.5e-8)).toBe('1.5E-8');
    expect(toStepRealScaled(1e21)).toBe('1.E+21');
  });

  it('guards NaN/Infinity/-0', () => {
    expect(toStepRealScaled(NaN)).toBe('0.');
    expect(toStepRealScaled(Infinity)).toBe('0.');
    expect(toStepRealScaled(-0)).toBe('0.');
  });
});

describe('scaleNumberLiterals', () => {
  it('scales every coordinate incl. the canonical trailing-dot form', () => {
    expect(scaleNumberLiterals('(3000.,0.,-1.5)', 0.001)).toBe('(3.,0.,-0.0015)');
  });

  it('keeps exponent and leading-dot reals intact (scales mantissa only)', () => {
    expect(scaleNumberLiterals('(1.E-5,.5,-2.5E2)', 1000)).toBe('(0.01,500.,-250000.)');
  });

  it('scales nested coordinate lists', () => {
    expect(scaleNumberLiterals('((0.,0.),(1000.,2000.))', 0.001)).toBe('((0.,0.),(1.,2.))');
  });

  it('never touches #-references or quoted strings', () => {
    expect(scaleNumberLiterals("#5,'Room (3000)',100.", 0.001)).toBe("#5,'Room (3000)',0.1");
  });
});

describe('scaleTypedMeasures', () => {
  it('scales each typed measure by its own dimension factor', () => {
    // length ×0.001, area unchanged, volume unchanged (the Revit case).
    expect(scaleTypedMeasures('IFCLENGTHMEASURE(100.),IFCAREAMEASURE(4.),IFCVOLUMEMEASURE(8.)', 0.001, 1, 1))
      .toBe('IFCLENGTHMEASURE(0.1),IFCAREAMEASURE(4.),IFCVOLUMEMEASURE(8.)');
  });

  it('scales area/volume when the model uses length-derived units', () => {
    expect(scaleTypedMeasures('IFCAREAMEASURE(4000000.),IFCVOLUMEMEASURE(8000000000.)', 0.001, 1e-6, 1e-9))
      .toBe('IFCAREAMEASURE(4.),IFCVOLUMEMEASURE(8.)');
  });

  it('covers the positive/non-negative length aliases', () => {
    expect(scaleTypedMeasures('IFCPOSITIVELENGTHMEASURE(5.),IFCNONNEGATIVELENGTHMEASURE(0.)', 0.001, 1, 1))
      .toBe('IFCPOSITIVELENGTHMEASURE(0.005),IFCNONNEGATIVELENGTHMEASURE(0.)');
  });

  it('never scales measure-looking text inside a quoted string', () => {
    expect(scaleTypedMeasures("IFCTEXT('e.g. IFCLENGTHMEASURE(100.)')", 0.001, 1, 1))
      .toBe("IFCTEXT('e.g. IFCLENGTHMEASURE(100.)')");
  });

  it('scales every measure in a comma-separated list (boundary handling without lookbehind)', () => {
    expect(scaleTypedMeasures('(IFCLENGTHMEASURE(1000.),IFCLENGTHMEASURE(2000.))', 0.001, 1, 1))
      .toBe('(IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.))');
  });
});

describe('getEntityLengthPlan (schema-derived)', () => {
  it('finds coordinate lists', () => {
    expect(getEntityLengthPlan('IFCCARTESIANPOINT').listIdx).toEqual([0]);
    expect(getEntityLengthPlan('IFCCARTESIANPOINTLIST3D').listIdx).toEqual([0]);
  });

  it('finds scalar lengths and excludes angles on shape profiles', () => {
    // I-shape: OverallWidth(3)..FlangeEdgeRadius(8) are lengths; FlangeSlope(9) is an angle.
    expect(getEntityLengthPlan('IFCISHAPEPROFILEDEF').scalarIdx).toEqual([3, 4, 5, 6, 7, 8]);
    expect(getEntityLengthPlan('IFCEXTRUDEDAREASOLID').scalarIdx).toEqual([3]);
    expect(getEntityLengthPlan('IFCBUILDINGSTOREY').scalarIdx).toEqual([9]);
    expect(getEntityLengthPlan('IFCSITE').scalarIdx).toEqual([11]);
  });

  it('classifies area/volume quantities and their unit guard', () => {
    const area = getEntityLengthPlan('IFCQUANTITYAREA');
    expect(area.areaIdx).toEqual([3]);
    expect(area.unitGuardIdx).toEqual([2]);
    const vol = getEntityLengthPlan('IFCQUANTITYVOLUME');
    expect(vol.volumeIdx).toEqual([3]);
    const len = getEntityLengthPlan('IFCQUANTITYLENGTH');
    expect(len.scalarIdx).toEqual([3]);
    expect(len.unitGuardIdx).toEqual([2]);
  });

  it('excludes unit-definition and georeferencing entities', () => {
    expect(getEntityLengthPlan('IFCSIUNIT').empty).toBe(true);
    expect(getEntityLengthPlan('IFCMEASUREWITHUNIT').empty).toBe(true);
    expect(getEntityLengthPlan('IFCMAPCONVERSION').empty).toBe(true);
  });

  it('leaves directions and pure geometry-of-directions untouched', () => {
    expect(getEntityLengthPlan('IFCDIRECTION').empty).toBe(true);
    expect(getEntityLengthPlan('IFCAXIS2PLACEMENT3D').empty).toBe(true);
  });
});

describe('rescaleEntityLengths (full entity lines)', () => {
  it('scales cartesian point coordinates', () => {
    expect(rescaleEntityLengths('#6=IFCCARTESIANPOINT((100.,200.,300.));', 'IFCCARTESIANPOINT', 0.001, 1, 1))
      .toBe('#6=IFCCARTESIANPOINT((0.1,0.2,0.3));');
  });

  it('scales an extrusion depth without touching #-refs', () => {
    expect(rescaleEntityLengths('#7=IFCEXTRUDEDAREASOLID(#1,#2,#3,2500.);', 'IFCEXTRUDEDAREASOLID', 0.001, 1, 1))
      .toBe('#7=IFCEXTRUDEDAREASOLID(#1,#2,#3,2.5);');
  });

  it('scales a storey elevation at index 9', () => {
    expect(rescaleEntityLengths("#8=IFCBUILDINGSTOREY('g',$,'L1',$,$,$,$,$,.ELEMENT.,3000.);", 'IFCBUILDINGSTOREY', 0.001, 1, 1))
      .toBe("#8=IFCBUILDINGSTOREY('g',$,'L1',$,$,$,$,$,.ELEMENT.,3.);");
  });

  it('leaves a Revit area quantity alone (areaFactor 1) but scales a length-derived one', () => {
    expect(rescaleEntityLengths("#9=IFCQUANTITYAREA('A',$,$,120.5,$);", 'IFCQUANTITYAREA', 0.001, 1, 1))
      .toBe("#9=IFCQUANTITYAREA('A',$,$,120.5,$);");
    expect(rescaleEntityLengths("#9=IFCQUANTITYAREA('A',$,$,5000000.,$);", 'IFCQUANTITYAREA', 0.001, 1e-6, 1e-9))
      .toBe("#9=IFCQUANTITYAREA('A',$,$,5.,$);");
  });

  it('does not scale a quantity that carries its own explicit unit', () => {
    expect(rescaleEntityLengths("#10=IFCQUANTITYLENGTH('L',$,#99,2500.,$);", 'IFCQUANTITYLENGTH', 0.001, 1, 1))
      .toBe("#10=IFCQUANTITYLENGTH('L',$,#99,2500.,$);");
  });

  it('does not scale a property that carries its own explicit unit', () => {
    expect(rescaleEntityLengths("#14=IFCPROPERTYSINGLEVALUE('T',$,IFCLENGTHMEASURE(50.),#77);", 'IFCPROPERTYSINGLEVALUE', 0.001, 1, 1))
      .toBe("#14=IFCPROPERTYSINGLEVALUE('T',$,IFCLENGTHMEASURE(50.),#77);");
  });

  it('does not scale an IfcPropertyTableValue that declares its own DefiningUnit', () => {
    // Attrs: Name,Description,DefiningValues,DefinedValues,Expression,DefiningUnit(5),DefinedUnit(6).
    // DefiningUnit is a live ref → the table's values are already in its own unit.
    const line = "#30=IFCPROPERTYTABLEVALUE('T',$,(IFCLENGTHMEASURE(10.)),(IFCLENGTHMEASURE(20.)),$,#88,$);";
    expect(rescaleEntityLengths(line, 'IFCPROPERTYTABLEVALUE', 0.001, 1, 1)).toBe(line);
  });

  it('scales an IfcPropertyTableValue with no explicit unit', () => {
    const line = "#31=IFCPROPERTYTABLEVALUE('T',$,(IFCLENGTHMEASURE(10.)),(IFCLENGTHMEASURE(20.)),$,$,$);";
    expect(rescaleEntityLengths(line, 'IFCPROPERTYTABLEVALUE', 0.001, 1, 1))
      .toBe("#31=IFCPROPERTYTABLEVALUE('T',$,(IFCLENGTHMEASURE(0.01)),(IFCLENGTHMEASURE(0.02)),$,$,$);");
  });

  it('scales a typed measure across a string with unbalanced parens', () => {
    expect(rescaleEntityLengths("#13=IFCPROPERTYSINGLEVALUE('A )( B',$,IFCLENGTHMEASURE(5.),$);", 'IFCPROPERTYSINGLEVALUE', 0.001, 1, 1))
      .toBe("#13=IFCPROPERTYSINGLEVALUE('A )( B',$,IFCLENGTHMEASURE(0.005),$);");
  });

  it('never rescales a direction, an angle, a count, or a name with digits', () => {
    expect(rescaleEntityLengths('#11=IFCDIRECTION((0.,0.,1.));', 'IFCDIRECTION', 0.001, 1, 1))
      .toBe('#11=IFCDIRECTION((0.,0.,1.));');
    expect(rescaleEntityLengths("#12=IFCWALL('g',#1,'Room 3000',$,$,$,$,$);", 'IFCWALL', 0.001, 1, 1))
      .toBe("#12=IFCWALL('g',#1,'Room 3000',$,$,$,$,$);");
    // A revolve's Angle (index 3) is an IfcPlaneAngleMeasure — untouched.
    expect(rescaleEntityLengths('#20=IFCREVOLVEDAREASOLID(#1,#2,#3,1.5708);', 'IFCREVOLVEDAREASOLID', 0.001, 1, 1))
      .toBe('#20=IFCREVOLVEDAREASOLID(#1,#2,#3,1.5708);');
  });

  it('never corrupts a unit-definition entity', () => {
    expect(rescaleEntityLengths('#15=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#5);', 'IFCMEASUREWITHUNIT', 0.001, 1, 1))
      .toBe('#15=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#5);');
  });

  it('is a no-op when all factors are 1', () => {
    const line = '#6=IFCCARTESIANPOINT((100.,200.,300.));';
    expect(rescaleEntityLengths(line, 'IFCCARTESIANPOINT', 1, 1, 1)).toBe(line);
  });
});

describe('computeNormalizeFactor', () => {
  it('returns the ratio metres-per-unit', () => {
    expect(computeNormalizeFactor(0.001, 1.0)).toBe(0.001); // mm into metres
    expect(computeNormalizeFactor(1.0, 0.001)).toBe(1000); // metres into mm
    expect(computeNormalizeFactor(0.3048, 1.0)).toBeCloseTo(0.3048, 10); // feet into metres
  });

  it('returns 1 for equal or invalid scales', () => {
    expect(computeNormalizeFactor(1, 1)).toBe(1);
    expect(computeNormalizeFactor(0, 1)).toBe(1);
    expect(computeNormalizeFactor(1, NaN)).toBe(1);
  });
});
