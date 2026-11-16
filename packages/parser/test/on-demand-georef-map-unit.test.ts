/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractGeoreferencingOnDemand } from '../src/on-demand-extractors.js';

/**
 * The on-demand path pulled in an `IfcProjectedCRS`'s MapUnit record but not
 * what an `IfcConversionBasedUnit` scales by (IfcMeasureWithUnit ->
 * IfcSIUnit). A unit outside the reader's name table then fell back to the
 * METRE/1.0 default. Found by the `bim.georef` round trip: ifc-lite's own
 * exporter writes `US SURVEY FOOT` exactly this way, and it read back as metres.
 */
async function storeFromIfc(ifc: string) {
  const source = new TextEncoder().encode(ifc);
  const entityRefs = [...new StepTokenizer(source).scanEntitiesFast()].map((ref) => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset, byteLength: ref.length, lineNumber: ref.line,
  }));
  return new ColumnarParser().parseLite(source.buffer.slice(0), entityRefs, {});
}

const header = `#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,(#5),$);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);`;

describe('extractGeoreferencingOnDemand — conversion-based MapUnit', () => {
  it.each([
    ['US SURVEY FOOT', 1200 / 3937],
    // Not in the name table at all: only the declared factor can scale it.
    ['CHAIN', 20.1168],
  ])('reads %s through its IfcMeasureWithUnit', async (name, factor) => {
    const store = await storeFromIfc(`${header}
#10=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${factor}),#11);
#13=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'${name}',#12);
#20=IFCPROJECTEDCRS('EPSG:2227',$,'NAD83',$,$,$,#13);
#21=IFCMAPCONVERSION(#5,#20,6000000.,2100000.,12.,$,$,$);`);
    const georef = extractGeoreferencingOnDemand(store);
    expect(georef?.projectedCRS?.mapUnit).toBe(name);
    expect(georef?.projectedCRS?.mapUnitScale).toBeCloseTo(factor, 12);
  });
});

/**
 * `mapUnitResolved` says whether `mapUnit` was read or is the METRE default
 * the reader reports for a unit it cannot resolve. `bim.georef` carries a
 * unit into a write only when it was read (#10382 review).
 */
describe('extractGeoreferencingOnDemand — mapUnitResolved', () => {
  const crsWith = (unit: string | null) => `${header}
#10=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#11=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#12=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#11);
#14=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048006096),#11);
#15=IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#12);
#16=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(66.),#15);
#17=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(20.1168),#11);
#18=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(66.),#999);
#19=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(66.),$);
#30=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#31=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(66.),#30);
${unit ? `#13=${unit};` : ''}
#20=IFCPROJECTEDCRS('EPSG:2227',$,'NAD83',$,$,$,${unit ? '#13' : '$'});
#21=IFCMAPCONVERSION(#5,#20,6000000.,2100000.,12.,$,$,$);`;

  it.each([
    ['an IfcSIUnit metre', 'IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'METRE', 1, true],
    ['an IfcSIUnit millimetre', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)', 'MILLIMETRE', 0.001, true],
    ['an IfcConversionBasedUnitWithOffset foot (zero offset)', "IFCCONVERSIONBASEDUNITWITHOFFSET(#10,.LENGTHUNIT.,'FOOT',#12,0.)", 'FOOT', 0.3048, true],
    ['an IfcConversionBasedUnitWithOffset with a non-zero offset', "IFCCONVERSIONBASEDUNITWITHOFFSET(#10,.LENGTHUNIT.,'FOOT',#12,5.)", 'METRE', 1, false],
    ['an IfcConversionBasedUnit named FOOT whose declared factor is the survey foot (0.3048006096)', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'FOOT',#14)", 'FOOT', 0.3048, false],
    ['an unknown unit defined through a conversion-based component (66 feet): the component\'s own factor is not applied, so it stays unresolved', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'CHAIN',#16)", 'METRE', 1, false],
    ['an unknown unit whose measure names a component that is not in the file stays unresolved', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'CHAIN',#18)", 'METRE', 1, false],
    ['an unknown unit whose measure has no component unit at all stays unresolved', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'CHAIN',#19)", 'METRE', 1, false],
    ['an unknown unit whose component is an SI unit that is not a length stays unresolved', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'CHAIN',#31)", 'METRE', 1, false],
    ['an unknown unit defined through an SI prefix is read', "IFCCONVERSIONBASEDUNIT(#10,.LENGTHUNIT.,'CHAIN',#17)", 'CHAIN', 20.1168, true],
    ['an IfcContextDependentUnit (no factor)', "IFCCONTEXTDEPENDENTUNIT(#10,.LENGTHUNIT.,'CHAIN')", 'METRE', 1, false],
    ['an IfcSIUnit that is not a length', 'IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)', 'METRE', 1, false],
  ] as const)('%s', async (_name, unit, mapUnit, scale, resolved) => {
    const crs = extractGeoreferencingOnDemand(await storeFromIfc(crsWith(unit)))?.projectedCRS;
    expect(crs?.mapUnit).toBe(mapUnit);
    expect(crs?.mapUnitScale).toBeCloseTo(scale, 12);
    expect(crs?.mapUnitResolved).toBe(resolved);
  });

  it('is absent when the CRS has no MapUnit', async () => {
    const crs = extractGeoreferencingOnDemand(await storeFromIfc(crsWith(null)))?.projectedCRS;
    expect(crs?.mapUnit).toBeUndefined();
    expect(crs && 'mapUnitResolved' in crs).toBe(false);
  });
});
