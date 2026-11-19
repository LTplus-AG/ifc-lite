/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10886: a model normalized into the primary's length unit keeps its georeference. A CRS without a map unit is
 * read as metres, as the viewer reads it, and is written with an explicit metre unit; an operation into a CRS is
 * left as written.
 */

import { describe, expect, it, vi } from 'vitest';
import { IfcParser, extractGeoreferenceCandidatesOnDemand, type IfcDataStore, type MapConversion } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';
import { viewerAxisScales, viewerMapUnitScale } from './viewer-georef-scale.js';
// The viewer's own scale rule is the oracle. Its file re-exports from `@ifc-lite/geo/proj4`, which export does not
// depend on, so that one module is served from geo's source, and the file is imported by a path tsc does not follow.
vi.mock('@ifc-lite/geo/proj4', () => import('../../geo/src/map-unit.js'));
const VIEWER_GEO_SCALE = '../../../apps/viewer/src/lib/geo/geo-scale.ts';
type ScaleFields = Pick<MapConversion, 'scale' | 'factorX' | 'factorY' | 'factorZ'>;
const { getEffectiveAxisScales } = await import(/* @vite-ignore */ new URL(VIEWER_GEO_SCALE, import.meta.url).href) as {
  getEffectiveAxisScales: (conversion: ScaleFields, mapUnitScale: number, lengthUnitScale: number) => { x: number; y: number; z: number };
};

type Unit = 'm' | 'mm' | 'ft';
interface Spec { unit: Unit; mapUnit: Unit | '$'; easting: number; scale?: string; schema?: 'IFC4' | 'IFC4X3'; operation?: string }

const UNIT_REF: Record<Unit, string> = { m: '#2', mm: '#3', ft: '#4' };

const model = (name: string, { unit, mapUnit, easting, scale = '1.', schema = 'IFC4', operation }: Spec) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Project${name.toUpperCase()}000000000000${name}',$,'${name}',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCCONVERSIONBASEDUNIT(#5,.LENGTHUNIT.,'FOOT',#6);
#5=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#2);
#9=IFCUNITASSIGNMENT((${UNIT_REF[unit]}));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,${mapUnit === '$' ? '$' : UNIT_REF[mapUnit]});
${operation ?? `#21=IFCMAPCONVERSION(#14,#20,${easting}.,1200000.,500.,1.,0.,${scale});`}
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

/** The scale the viewer gives each map conversion's geometry, by the viewer's own rule. */
function viewerScales(store: IfcDataStore): string[] {
  return (extractGeoreferenceCandidatesOnDemand(store)?.mapConversions ?? []).map(({ conversion, targetCRS }) => {
    const { x, y, z } = getEffectiveAxisScales(conversion, viewerMapUnitScale(targetCRS?.mapUnitScale), store.lengthUnitScale ?? 1);
    return [x, y, z].map(value => value.toPrecision(9)).join(',');
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

  const SCALE: Record<Unit | '$', number> = { m: 1, mm: 0.001, ft: 0.3048, $: 1 };
  const scaleCases: Array<[string, Spec, Spec]> = [];
  for (const [primary, later] of [['m', 'mm'], ['mm', 'm']] as const) {
    for (const mapUnit of [later, primary, '$'] as const) {
      const bridging = SCALE[later] / SCALE[mapUnit];
      for (const scale of new Set(['$', '1.', '0.9996', Number.isInteger(bridging) ? `${bridging}.` : `${bridging}`])) {
        scaleCases.push([`${later} into ${primary}, map unit ${mapUnit}, Scale ${scale}`,
          { unit: primary, mapUnit: primary, easting: 2600000 }, { unit: later, mapUnit, easting: 2600100, scale }]);
      }
    }
  }

  it.each(scaleCases)('keeps the scale the viewer gives each model: %s', async (_, primary, later) => {
    const alone = [...viewerScales(await parse(model('a', primary))), ...viewerScales(await parse(model('b', later)))];
    const merged = viewerScales(await parse(await merge([primary, later])));
    expect(merged).toEqual(alone);
  });

  it('keeps apart two equal records the viewer scales differently in their own units', async () => {
    // Same offsets, Scale and MapUnit `$`, so the same origin; but 0.9996 scales metres and millimetres differently.
    const primary: Spec = { unit: 'm', mapUnit: '$', easting: 2600000, scale: '0.9996' };
    const later: Spec = { unit: 'mm', mapUnit: '$', easting: 2600000, scale: '0.9996' };
    const alone = [...viewerScales(await parse(model('a', primary))), ...viewerScales(await parse(model('b', later)))];
    expect(viewerScales(await parse(await merge([primary, later])))).toEqual(alone);
  });

  it('copies the viewer\'s scale rule exactly', () => {
    for (const scale of [undefined, 1, 0.001, 0.9996, 1000]) {
      for (const factor of [undefined, 1, 0.3048, 0.9996]) {
        for (const [mapUnit, project] of [[1, 1], [1, 0.001], [0.001, 1], [0.3048, 0.001], [undefined, 0.3048]] as const) {
          const conversion = { scale, factorX: factor, factorY: factor, factorZ: factor === undefined ? undefined : 1 };
          const { x, y, z } = getEffectiveAxisScales(conversion, viewerMapUnitScale(mapUnit), project);
          expect(viewerAxisScales(conversion, mapUnit, project)).toEqual([x, y, z]);
        }
      }
    }
  });

  it.each([['Factors bridging feet to metres', 'ft', '0.3048,0.3048,1.'], ['grid Factors', 'mm', '0.9996,0.9996,1.']] as const)(
    'keeps the viewer\'s scale with %s', async (_, unit, factors) => {
    const operation = `#21=IFCMAPCONVERSIONSCALED(#14,#20,2600100.,1200000.,500.,1.,0.,$,${factors});`;
    const primary: Spec = { unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' };
    const later: Spec = { unit, mapUnit: 'm', easting: 0, schema: 'IFC4X3', operation };
    const alone = [...viewerScales(await parse(model('a', primary))), ...viewerScales(await parse(model('b', later)))];
    expect(viewerScales(await parse(await merge([primary, later])))).toEqual(alone);
  });

  it('gives a geographic CRS without a height unit the metre unit', async () => {
    const operation = `#21=IFCRIGIDOPERATION(#14,#22,IFCPLANEANGLEMEASURE(8.5),IFCPLANEANGLEMEASURE(47.4),500.);
#22=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$);`;
    const merged = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' },
      { unit: 'mm', mapUnit: 'mm', easting: 0, schema: 'IFC4X3', operation }]);
    const metre = [...merged.matchAll(METRE_UNIT)].at(-1)![1];
    expect(merged).toMatch(new RegExp(`=IFCGEOGRAPHICCRS\\('EPSG:4326',\\$,\\$,\\$,\\$,#${metre}\\);`));
    expect(merged).toMatch(/=IFCRIGIDOPERATION\(#\d+,#\d+,IFCPLANEANGLEMEASURE\(8\.5\),IFCPLANEANGLEMEASURE\(47\.4\),500\.\);/);
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
