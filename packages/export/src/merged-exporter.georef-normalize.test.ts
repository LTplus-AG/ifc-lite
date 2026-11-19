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
interface Spec {
  unit: Unit; mapUnit: Unit | '$'; easting: number; scale?: string; schema?: 'IFC4' | 'IFC4X3'; operation?: string;
  /** Write the unset map unit with a STEP comment after it. */
  mapUnitComment?: boolean;
}

const UNIT_REF: Record<Unit, string> = { m: '#2', mm: '#3', ft: '#4' };

const model = (name: string, { unit, mapUnit, easting, scale = '1.', schema = 'IFC4', operation, mapUnitComment }: Spec) => `ISO-10303-21;
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
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,${mapUnit === '$' ? `$${mapUnitComment ? ' /* unspecified */' : ''}` : UNIT_REF[mapUnit]});
${operation ?? `#21=IFCMAPCONVERSION(#14,#20,${easting}.,1200000.,500.,1.,0.,${scale});`}
ENDSEC;
END-ISO-10303-21;
`;

const parse = async (text: string, options?: Parameters<IfcParser['parseColumnar']>[1]) =>
  new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, options);

async function merge(specs: Spec[]) {
  return new TextDecoder().decode((await mergeResult(specs)).content);
}

async function mergeResult(specs: Spec[]) {
  const inputs: MergeModelInput[] = await Promise.all(specs.map(async (spec, index) => {
    const id = String.fromCharCode(97 + index);
    return { id, name: id, dataStore: await parse(model(id, spec)) };
  }));
  const schema = specs[0].schema ?? 'IFC4';
  return new MergedExporter(inputs).exportAsync({ schema, unitReconciliation: 'normalize' });
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

  it.each([
    ['a mm model with a mm map unit and Scale 0.001', { unit: 'mm', mapUnit: 'mm', scale: '0.001' }, 'm'],
    ['an m model with an m map unit and Scale 1000', { unit: 'm', mapUnit: 'm', scale: '1000.' }, 'mm'],
    // Divided, 0.9999999989997 is written to 12 digits as 0.999999999, which the viewer reads as an unset Scale.
    ['a mm model whose divided Scale rounds to 1', { unit: 'mm', mapUnit: 'mm', scale: '0.0009999999989997' }, 'm'],
  ] as const)('names a map conversion whose viewer scale no Scale keeps: %s', async (_, later, primaryUnit) => {
    const { stats } = await mergeResult([{ unit: primaryUnit, mapUnit: primaryUnit, easting: 2600000 }, { ...later, easting: 2600100 }]);
    // #21 is the conversion's id in model "b", the later model.
    expect(stats.warnings.filter(warning => warning.includes('cannot show'))).toEqual([
      expect.stringContaining('The viewer cannot show its map conversion #21 (an id in "b") at its own scale'),
    ]);
  });

  it('names a map conversion whose viewer scale is far below 1 and changes', async () => {
    // Alone the viewer scales it by 1.E-9; with Scale as written it would be 1.E-12, a change only a relative tolerance sees.
    const operation = '#21=IFCMAPCONVERSIONSCALED(#14,#20,2600100.,1200000.,500.,1.,0.,0.001,1.E-06,1.E-06,1.E-06);';
    const { stats, content } = await mergeResult([{ unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' },
      { unit: 'mm', mapUnit: 'mm', easting: 0, schema: 'IFC4X3', operation }]);
    expect(stats.warnings.filter(warning => warning.includes('cannot show'))).toEqual([
      expect.stringContaining('The viewer cannot show its map conversion #21 (an id in "b") at its own scale'),
    ]);
    // Written with the divided, spec Scale.
    expect(new TextDecoder().decode(content)).toMatch(/=IFCMAPCONVERSIONSCALED\([^;]*,0\.,1\.,1\.E-0?6,1\.E-0?6,1\.E-0?6\);/);
  });

  it('names no map conversion when a Scale keeps the viewer\'s scale', async () => {
    const { stats } = await mergeResult([{ unit: 'm', mapUnit: 'm', easting: 2600000 }, { unit: 'mm', mapUnit: 'm', easting: 2600100, scale: '0.001' }]);
    expect(stats.warnings.some(warning => warning.includes('georeferencing'))).toBe(true);
    expect(stats.warnings.some(warning => warning.includes('cannot show'))).toBe(false);
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

  it('reads a commented `$` as a missing map unit', async () => {
    const merged = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000 },
      { unit: 'mm', mapUnit: '$', easting: 2600100, mapUnitComment: true }]);
    const metre = [...merged.matchAll(METRE_UNIT)].at(-1)![1];
    expect(crsUnits(merged)).toEqual(['#2', `#${metre}`]);
  });

  it('normalizes the context-to-CRS scale and preserves the chained CRS-to-CRS conversion', async () => {
    const primary: Spec = { unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' };
    const operation = `#21=IFCMAPCONVERSION(#14,#20,2600100.,1200000.,500.,1.,0.,0.0009996);
#23=IFCPROJECTEDCRS('EPSG:21781',$,$,$,$,$,#2);
#24=IFCMAPCONVERSION(#20,#23,10.,20.,30.,1.,0.,0.9996);`;
    const merged = await merge([primary, { ...primary, unit: 'mm', operation }]);
    const conversions = extractGeoreferenceCandidatesOnDemand(await parse(merged))?.mapConversions ?? [];
    expect(conversions).toHaveLength(3);
    const context = conversions.find(({ conversion }) => conversion.eastings === 2600100)?.conversion;
    const chain = conversions.find(({ conversion }) => conversion.eastings === 10)?.conversion;
    expect(context?.scale).toBe(0.9996);
    expect(chain).toMatchObject({
      sourceCRS: context?.targetCRS,
      eastings: 10,
      northings: 20,
      orthogonalHeight: 30,
      scale: 0.9996,
    });
  });

  it('leaves a rigid operation into a CRS as written', async () => {
    const operation = '#21=IFCRIGIDOPERATION(#14,#20,IFCLENGTHMEASURE(2600100.),IFCLENGTHMEASURE(1200000.),500.);';
    const merged = await merge([{ unit: 'm', mapUnit: 'm', easting: 2600000, schema: 'IFC4X3' },
      { unit: 'mm', mapUnit: 'mm', easting: 0, schema: 'IFC4X3', operation }]);
    expect(merged).toMatch(/=IFCRIGIDOPERATION\(#\d+,#\d+,IFCLENGTHMEASURE\(2600100\.\),IFCLENGTHMEASURE\(1200000\.\),500\.\);/);
  });
});

/** An IFC2X3 model, georeferenced through `ePSet_MapConversion` unless `easting` is null (#10915). */
interface EPSetSpec {
  unit: 'm' | 'mm'; easting: number | null;
  /** The Scale property: a real, or a whole NominalValue such as `IFCLABEL('0.5x')`. */
  scale?: string;
  /** The `ePSet_ProjectedCRS` MapUnit label, `$` for an unset value, or none for no MapUnit property. */
  mapUnit?: string;
  /** False for a model with no `ePSet_ProjectedCRS`. */
  crsSet?: false;
  /** Parse the model with its property atoms in the deferred index. */
  deferAtoms?: true;
  /** Write the set and offset names with a STEP `\X\` escape for their first letter. */
  escapedNames?: true;
  /** The MapUnit property's NominalValue and Unit, written as given (e.g. `$,#3`), in place of `mapUnit`. */
  mapUnitSlots?: string;
  /** The whole Scale property record, in place of `scale`. */
  scaleRecord?: string;
  /** The MapUnit property's entity type, IFCPROPERTYSINGLEVALUE when not given. */
  mapUnitRecord?: string;
  /** List a property the file does not define in the ePSet_MapConversion. */
  danglingProperty?: true;
  /** Add a length that is no placement property, `SourceLength`, to the ePSet_MapConversion. */
  extraLength?: true;
}

const epsetModel = (name: string, { unit, easting, scale, mapUnit, crsSet, escapedNames, mapUnitSlots, scaleRecord, mapUnitRecord = 'IFCPROPERTYSINGLEVALUE', danglingProperty, extraLength }: EPSetSpec) => {
  const guid = (n: number) => `'0${name.toUpperCase()}EPSet${String(n).padStart(15, '0')}'`;
  // `\X\65` is `e`, `\X\45` is `E`, `\X\4E` is `N`, `\X\4F` is `O`.
  const [eps, east, north, height] = escapedNames ? ['\\X\\65PSet', '\\X\\45astings', '\\X\\4Eorthings', '\\X\\4FrthogonalHeight']
    : ['ePSet', 'Eastings', 'Northings', 'OrthogonalHeight'];
  const georef = easting === null ? '' : `#30=IFCPROPERTYSINGLEVALUE('${east}',$,IFCLENGTHMEASURE(${easting}.),$);
#31=IFCPROPERTYSINGLEVALUE('${north}',$,IFCLENGTHMEASURE(1200000.),$);
#32=IFCPROPERTYSINGLEVALUE('${height}',$,IFCLENGTHMEASURE(500.),$);
${scaleRecord !== undefined ? `#33=${scaleRecord};`
    : scale === undefined ? '' : `#33=IFCPROPERTYSINGLEVALUE('Scale',$,${scale.startsWith('IFC') ? scale : `IFCREAL(${scale})`},$);`}
#34=IFCPROPERTYSET(${guid(2)},#8,'${eps}_MapConversion',$,(#30,#31,#32${scale === undefined && scaleRecord === undefined ? '' : ',#33'}${danglingProperty ? ',#99' : ''}${extraLength ? ',#40' : ''}));
${extraLength ? "#40=IFCPROPERTYSINGLEVALUE('SourceLength',$,IFCLENGTHMEASURE(1000.),$);" : ''}
#35=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
${mapUnitSlots !== undefined ? `#36=${mapUnitRecord}('MapUnit',$,${mapUnitSlots});`
    : mapUnit === undefined ? '' : `#36=IFCPROPERTYSINGLEVALUE('MapUnit',$,${mapUnit === '$' ? '$' : `IFCLABEL('${mapUnit}')`},$);`}
#38=IFCRELDEFINESBYPROPERTIES(${guid(4)},#8,$,$,(#1),#34);
${crsSet === false ? '' : `#37=IFCPROPERTYSET(${guid(3)},#8,'ePSet_ProjectedCRS',$,(#35${mapUnit === undefined && mapUnitSlots === undefined ? '' : ',#36'}));
#39=IFCRELDEFINESBYPROPERTIES(${guid(5)},#8,$,$,(#1),#37);`}`;
  return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT(${guid(1)},#8,'${name}',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCPERSON($,$,'a',$,$,$,$,$);
#5=IFCORGANIZATION($,'o',$,$,$);
#6=IFCPERSONANDORGANIZATION(#4,#5,$);
#7=IFCAPPLICATION(#5,'1','t ${name}','t${name}');
#8=IFCOWNERHISTORY(#6,#7,$,.ADDED.,$,$,$,0);
#9=IFCUNITASSIGNMENT((${unit === 'm' ? '#2' : '#3'}));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
${georef}
ENDSEC;
END-ISO-10303-21;
`;
};

async function mergeEPSets(specs: EPSetSpec[]) {
  const inputs: MergeModelInput[] = await Promise.all(specs.map(async (spec, index) => {
    const id = String.fromCharCode(97 + index);
    const options = spec.deferAtoms ? { disableWorkerScan: true, deferPropertyAtomIndex: true } : undefined;
    return { id, name: id, dataStore: await parse(epsetModel(id, spec), options) };
  }));
  const { content, stats } = await new MergedExporter(inputs).exportAsync({ schema: 'IFC2X3', unitReconciliation: 'normalize' });
  return { merged: new TextDecoder().decode(content), warnings: stats.warnings };
}

/** Where and at what scale the viewer puts the first `ePSet_MapConversion`, by the viewer's own rule. */
function viewerEPSet(store: IfcDataStore): string {
  const { mapConversion: conversion, projectedCRS } = extractGeoreferenceCandidatesOnDemand(store)?.ePSetMapConversion ?? {};
  if (!conversion) return 'none';
  const mapUnit = viewerMapUnitScale(projectedCRS?.mapUnitScale);
  const { x, y, z } = getEffectiveAxisScales(conversion, mapUnit, store.lengthUnitScale ?? 1);
  return [conversion.eastings * mapUnit, conversion.northings * mapUnit, conversion.orthogonalHeight * mapUnit, x, y, z]
    .map(value => value.toPrecision(9)).join(',');
}

describe('normalize keeps an IFC2X3 ePSet_MapConversion georeference (#10915)', () => {
  const cases: Array<[string, EPSetSpec]> = [];
  for (const mapUnit of ['MILLIMETRE', 'METRE', '$', undefined]) {
    for (const scale of [undefined, '1.', '0.9996', '0.001']) {
      // No Scale shows a millimetre map unit at 0.001 in metres: the divided 1 reads as unset (named below).
      if (mapUnit === 'MILLIMETRE' && scale === '0.001') continue;
      cases.push([`map unit ${mapUnit ?? 'none'}, Scale ${scale ?? 'none'}`, { unit: 'mm', easting: 2600100, scale, mapUnit }]);
    }
  }

  it('reads a millimetre model alone at its ePSet origin and scale', async () => {
    // 2600100 m east, 1200000 m north, 500 m up; Scale unset with a metre map unit, so the viewer draws at 1.
    expect(viewerEPSet(await parse(epsetModel('b', { unit: 'mm', easting: 2600100, mapUnit: 'METRE' }))))
      .toBe('2600100.00,1200000.00,500.000000,1.00000000,1.00000000,1.00000000');
  });

  it.each(cases)('puts a millimetre model where and at the scale the viewer puts it alone: %s', async (_, later) => {
    const alone = viewerEPSet(await parse(epsetModel('b', later)));
    expect(alone).not.toBe('none');
    const { merged, warnings } = await mergeEPSets([{ unit: 'm', easting: null }, later]);
    expect(warnings.some(warning => warning.includes('cannot show'))).toBe(false);
    expect(viewerEPSet(await parse(merged))).toEqual(alone);
    // A CRS set without a MapUnit names metres, so a reader that takes the project unit agrees.
    expect(merged).toMatch(/IFCPROPERTYSINGLEVALUE\('MapUnit',\$,IFCLABEL\('(METRE|MILLIMETRE)'\),\$\)/);
  });

  it('leaves a later model\'s offsets as written when the primary is georeferenced too', async () => {
    const { merged } = await mergeEPSets([{ unit: 'm', easting: 2600000, mapUnit: 'METRE' }, { unit: 'mm', easting: 2600100 }]);
    expect(merged).toContain("IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2600100.),$)");
    expect(merged.match(/IFCPROPERTYSINGLEVALUE\('MapUnit',\$,IFCLABEL\('METRE'\),\$\)/g)).toHaveLength(2);
  });

  // `placed` false: the parser refuses a Scale that is no number, so the viewer places the model neither alone nor merged.
  it.each([
    ['its property atoms are deferred', { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE', deferAtoms: true }, true],
    ['its Scale is a string the viewer does not read as a number', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: "IFCLABEL('0.5x')" }, false],
    ['its Scale is a numeric string', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: "IFCLABEL('0.001')" }, true],
    ['its Scale carries a STEP comment', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: 'IFCREAL(0.9996 /* grid */)' }, true],
    ['its names are STEP-escaped', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', escapedNames: true }, true],
    ['its Scale is no number and its map unit is not the project unit', { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE', scale: "IFCLABEL('0.5x')" }, false],
    ['its Scale overflows', { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE', scale: 'IFCREAL(1.E400)' }, false],
    ['its Scale is written as a length', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: 'IFCLENGTHMEASURE(1.)' }, true],
    ['its Scale is an escaped number', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: "IFCLABEL('\\X\\30.001')" }, true],
    ['its MapUnit label is empty', { unit: 'mm', easting: 2600100, mapUnit: '' }, true],
    ['a comment sits before its typed MapUnit', { unit: 'mm', easting: 2600100, mapUnitSlots: "/* u */ IFCLABEL('MILLIMETRE'),$", scale: '0.5' }, true],
    ['its MapUnit is an enumeration', { unit: 'mm', easting: 2600100, mapUnitSlots: '.MILLIMETRE.,$', scale: '0.5' }, true],
    ['its Scale is a malformed real', { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE', scale: 'IFCREAL(1.52.3)' }, false],
    ['a comment follows its typed Scale', { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: 'IFCREAL(0.001) /* grid */' }, true],
    ['its Scale is an enumerated value', { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE',
      scaleRecord: "IFCPROPERTYENUMERATEDVALUE('Scale',$,(IFCREAL(0.5)),$)" }, true],
  ] as const)('puts a millimetre model where the viewer puts it alone when %s', async (_, later, placed) => {
    const alone = viewerEPSet(await parse(epsetModel('b', later)));
    expect(alone === 'none').toBe(!placed);
    const { merged } = await mergeEPSets([{ unit: 'm', easting: null }, later]);
    expect(viewerEPSet(await parse(merged))).toEqual(alone);
    expect(merged.match(/IFCPROPERTYSINGLEVALUE\('MapUnit',/g)).toHaveLength(1);
  });

  it('leaves a Scale property that is no single value as it is, and names its set only when that moves the model', async () => {
    // The parser reads no Scale from an enumerated value, and kept unset it keeps the viewer's scale: no advisory.
    const enumerated = await mergeEPSets([{ unit: 'm', easting: null },
      { unit: 'mm', easting: 2600100, mapUnit: 'MILLIMETRE', scaleRecord: "IFCPROPERTYENUMERATEDVALUE('Scale',$,(IFCREAL(0.5)),$)" }]);
    expect(enumerated.merged).toContain("IFCPROPERTYENUMERATEDVALUE('Scale',$,(IFCREAL(0.5)),$)");
    expect(enumerated.warnings.some(warning => warning.includes('Scale property'))).toBe(false);
    // A bounded value the parser reads as 0.001 cannot be rewritten, so the viewer's scale changes: named.
    const bounded = await mergeEPSets([{ unit: 'm', easting: null },
      { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scaleRecord: "IFCPROPERTYBOUNDEDVALUE('Scale',$,IFCREAL(0.001),$,$)" }]);
    expect(bounded.merged).toContain("IFCPROPERTYBOUNDEDVALUE('Scale',$,IFCREAL(0.001),$,$)");
    expect(bounded.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Normalize could not rewrite the Scale property of ePSet_MapConversion #34 (an id in "b")'),
    ]));
  });

  it('rescales a length in the ePSet_MapConversion that is no placement property', async () => {
    const { merged } = await mergeEPSets([{ unit: 'm', easting: null }, { unit: 'mm', easting: 2600100, mapUnit: 'METRE', extraLength: true }]);
    expect(merged).toContain("IFCPROPERTYSINGLEVALUE('SourceLength',$,IFCLENGTHMEASURE(1.),$)");
    expect(merged).toContain("IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2600100.),$)");
  });

  it('passes over a dangling property reference, as the parser does', async () => {
    const later: EPSetSpec = { unit: 'mm', easting: 2600100, mapUnit: 'METRE', scale: '0.001', danglingProperty: true };
    const alone = viewerEPSet(await parse(epsetModel('b', later)));
    const { merged } = await mergeEPSets([{ unit: 'm', easting: null }, later]);
    expect(alone).not.toBe('none');
    expect(viewerEPSet(await parse(merged))).toEqual(alone);
  });

  it('names an ePSet whose MapUnit normalize cannot write', async () => {
    const { warnings } = await mergeEPSets([{ unit: 'm', easting: null },
      { unit: 'mm', easting: 2600100, mapUnitSlots: '(IFCLABEL(\'MILLIMETRE\')),$', mapUnitRecord: 'IFCPROPERTYENUMERATEDVALUE' }]);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('The map unit of ePSet_MapConversion #34 (an id in "b") stays implicit'),
    ]));
  });

  it('gives an empty MapUnit label METRE, and leaves a MapUnit that carries its own Unit', async () => {
    const empty = await mergeEPSets([{ unit: 'm', easting: null }, { unit: 'mm', easting: 2600100, mapUnit: '' }]);
    expect(empty.merged).toContain("IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$)");
    const withUnit = await mergeEPSets([{ unit: 'm', easting: null }, { unit: 'mm', easting: 2600100, mapUnitSlots: '$,#3' }]);
    expect(withUnit.merged).toMatch(/IFCPROPERTYSINGLEVALUE\('MapUnit',\$,\$,#\d+\)/);
    expect(withUnit.merged).not.toContain("IFCLABEL('METRE')");
  });

  it('names an ePSet_MapConversion whose map unit stays implicit, with no ePSet_ProjectedCRS', async () => {
    const { merged, warnings } = await mergeEPSets([{ unit: 'm', easting: null }, { unit: 'mm', easting: 2600100, crsSet: false }]);
    expect(merged).toContain("IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2600100.),$)");
    expect(warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('The map unit of ePSet_MapConversion #34 (an id in "b") stays implicit'),
    ]));
  });

  it('names an ePSet_MapConversion whose viewer scale no Scale keeps', async () => {
    const { warnings } = await mergeEPSets([{ unit: 'm', easting: null }, { unit: 'mm', easting: 2600100, scale: '0.001', mapUnit: 'MILLIMETRE' }]);
    // #34 is the ePSet_MapConversion's id in model "b".
    expect(warnings.filter(warning => warning.includes('cannot show'))).toEqual([
      expect.stringContaining('The viewer cannot show its map conversion #34 (an id in "b") at its own scale'),
    ]);
  });
});
