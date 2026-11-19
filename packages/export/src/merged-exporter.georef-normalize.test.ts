/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10886: a model normalized into the primary's length unit keeps its georeference. A CRS without a map unit is
 * read as metres, as the viewer reads it, and is written with an explicit metre unit; an operation into a CRS is
 * left as written.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, extractGeoreferenceCandidatesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

type Unit = 'm' | 'mm';
interface Spec { unit: Unit; mapUnit: Unit | '$'; easting: number; schema?: 'IFC4' | 'IFC4X3'; operation?: string }

const UNIT_REF: Record<Unit, string> = { m: '#2', mm: '#3' };

const model = (name: string, { unit, mapUnit, easting, schema = 'IFC4', operation }: Spec) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project${name.toUpperCase()}000000000000${name}',$,'${name}',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCUNITASSIGNMENT((${UNIT_REF[unit]}));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,${mapUnit === '$' ? '$' : UNIT_REF[mapUnit]});
${operation ?? `#21=IFCMAPCONVERSION(#14,#20,${easting}.,1200000.,500.,1.,0.,1.);`}
ENDSEC;
END-ISO-10303-21;
`;

const parse = async (text: string) => new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer);

async function merge(specs: Spec[]) {
  const inputs: MergeModelInput[] = await Promise.all(specs.map(async (spec, index) => {
    const id = String.fromCharCode(97 + index);
    return { id, name: id, dataStore: await parse(model(id, spec)) };
  }));
  const schema = specs[0].schema ?? 'IFC4';
  return new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema, unitReconciliation: 'normalize' })).content);
}

/**
 * Where the viewer puts each map conversion's origin, in metres: the offsets in the CRS's map unit, a missing map
 * unit read as metres (`resolveMapUnitToMetreScale`, `@ifc-lite/geo` `map-unit.ts`).
 */
function viewerOrigins(store: IfcDataStore): number[][] {
  return (extractGeoreferenceCandidatesOnDemand(store)?.mapConversions ?? []).map(({ conversion, targetCRS }) => {
    const scale = targetCRS?.mapUnitScale && targetCRS.mapUnitScale > 0 ? targetCRS.mapUnitScale : 1;
    return [conversion.eastings, conversion.northings, conversion.orthogonalHeight].map(value => value * scale);
  });
}

const sorted = (origins: number[][]) => origins.map(origin => origin.join(',')).sort();
/** Each IfcProjectedCRS's map unit, in file order. */
const crsUnits = (content: string) => [...content.matchAll(/=IFCPROJECTEDCRS\([^;]*,([^,;]+)\);/g)].map(match => match[1]);
const METRE_UNIT = /^#(\d+)=IFCSIUNIT\(\*,\.LENGTHUNIT\.,\$,\.METRE\.\);$/gm;

describe('normalize keeps each model\'s georeference (#10886)', () => {
  const cases: Array<[string, Spec, Spec]> = [];
  for (const [primary, later] of [['m', 'mm'], ['mm', 'm']] as const) {
    for (const primaryMap of [primary, '$'] as const) {
      for (const laterMap of [later, '$'] as const) {
        cases.push([`${primary} (map unit ${primaryMap}) + ${later} (map unit ${laterMap})`,
          { unit: primary, mapUnit: primaryMap, easting: 2600000 }, { unit: later, mapUnit: laterMap, easting: 2600100 }]);
      }
    }
  }

  it.each(cases)('puts every model where the viewer puts it alone: %s', async (_, primary, later) => {
    const alone = [...viewerOrigins(await parse(model('a', primary))), ...viewerOrigins(await parse(model('b', later)))];
    const merged = await merge([primary, later]);
    expect(sorted(viewerOrigins(await parse(merged)))).toEqual(sorted(alone));
    // The later model's CRS is not left for a reader to resolve through the merged project's unit.
    expect(crsUnits(merged)[1]).toMatch(/^#\d+$/);
  });

  it('gives a CRS without a map unit one explicit metre unit, and none when no CRS needs it', async () => {
    const merged = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000 }, { unit: 'mm', mapUnit: '$', easting: 2600100 },
      { unit: 'mm', mapUnit: '$', easting: 2600200 }]);
    // Each input carries one metre unit of its own; the merge adds one, which both unitless CRSs name.
    const metre = [...merged.matchAll(METRE_UNIT)].map(match => `#${match[1]}`);
    expect(metre).toHaveLength(4);
    expect(crsUnits(merged)).toEqual(['#2', metre[3], metre[3]]);
    const withUnits = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000 }, { unit: 'mm', mapUnit: 'mm', easting: 2600100 }]);
    expect([...withUnits.matchAll(METRE_UNIT)]).toHaveLength(2);
  });

  it('leaves a rigid operation into a CRS as written', async () => {
    const operation = '#21=IFCRIGIDOPERATION(#14,#20,IFCLENGTHMEASURE(2600100.),IFCLENGTHMEASURE(1200000.),500.);';
    const merged = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' },
      { unit: 'mm', mapUnit: 'mm', easting: 0, schema: 'IFC4X3', operation }]);
    expect(merged).toMatch(/=IFCRIGIDOPERATION\(#\d+,#\d+,IFCLENGTHMEASURE\(2600100\.\),IFCLENGTHMEASURE\(1200000\.\),500\.\);/);
  });
});
