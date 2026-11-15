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
