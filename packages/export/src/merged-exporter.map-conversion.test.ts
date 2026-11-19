/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #10798: a merge unified a later model's representation context onto the primary's whenever their WCS frames
 * matched, and kept the later model's IfcMapConversion, so one frame got two georeferences.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

/**
 * `values` for an IFCMAPCONVERSION into a CRS in map unit `unit` (#2 metre, #3 millimetre, #4 a conversion-based
 * unit of `factor` metres, $ the project's), or a whole record line when `raw`; `projectUnit` is the model's length unit.
 */
interface Georef { values?: string; unit?: '#2' | '#3' | '#4' | '$'; factor?: string; raw?: string; projectUnit?: '#2' | '#3' }
const georefLines = ({ values, unit = '#2', factor = '0.3048', raw }: Georef) => `#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCCONVERSIONBASEDUNIT(#5,.LENGTHUNIT.,'FOOT',#6);
#5=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${factor}),#2);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,${unit});
${raw ?? `#21=IFCMAPCONVERSION(#14,#20,${values});`}`;

const model = (name: string, project: string, georef: Georef | null, schema: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('${project}',$,'${name}',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCUNITASSIGNMENT((${georef?.projectUnit ?? '#2'}));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
${georef === null ? '' : georefLines(georef)}
ENDSEC;
END-ISO-10303-21;
`;

async function input(id: string, georef: Georef | null, schema: 'IFC4' | 'IFC4X3'): Promise<MergeModelInput> {
  const bytes = new TextEncoder().encode(model(id, `0Project${id.toUpperCase()}000000000000${id}`, georef, schema));
  return { id, name: id, dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) };
}

const X = '2600000.,1200000.,500.,1.,0.,1.';
const Y = '2700000.,1200000.,500.,1.,0.,1.';
const at = (values: string): Georef => ({ values });

async function merge(georefs: (Georef | null)[], schema: 'IFC4' | 'IFC4X3' = 'IFC4', unitReconciliation?: 'normalize') {
  const inputs = await Promise.all(georefs.map((georef, index) => input(String.fromCharCode(97 + index), georef, schema)));
  const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema, unitReconciliation })).content);
  const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
  const sources = [...content.matchAll(/=IFC(?:MAPCONVERSION|RIGIDOPERATION)\((#\d+),/g)].map(match => match[1]);
  return { contexts, sources };
}

/** Every georeference sits on its own context, each a context of the file. */
function expectApart({ contexts, sources }: Awaited<ReturnType<typeof merge>>, count: number) {
  expect(contexts).toHaveLength(count);
  expect(sources).toHaveLength(count);
  expect(new Set(sources).size).toBe(count);
  expect(sources.every(source => contexts.includes(source))).toBe(true);
}

describe('merged STEP export and map conversions (#10798)', () => {
  it('keeps a second model with a different map conversion on its own context', async () => {
    expectApart(await merge([at(X), at(Y)]), 2);
  });

  it('still unifies two models with the same map conversion, or where only one is georeferenced', async () => {
    expect((await merge([at(X), at(X)])).contexts).toHaveLength(1);
    expect((await merge([at(X), null])).contexts).toHaveLength(1);
    expect((await merge([null, at(X)])).contexts).toHaveLength(1);
  });

  it('checks each later model against a georeference an earlier one gave the shared context', async () => {
    // The primary has none, so the second model's conversion lands on its context: the third's must agree with it.
    const result = await merge([null, at(X), at(Y)]);
    expect(result.contexts).toHaveLength(2);
    expect(new Set(result.sources).size).toBe(2);
  });

  it('tells apart the same numbers in different map units', async () => {
    expectApart(await merge([at(X), { values: X, unit: '#3' }]), 2);
    // A CRS without a map unit uses the project's.
    expectApart(await merge([{ values: X, unit: '$' }, { values: X, unit: '$', projectUnit: '#3' }], 'IFC4', 'normalize'), 2);
    expect((await merge([{ values: X, unit: '$' }, { values: X, unit: '$' }])).contexts).toHaveLength(1);
    // A conversion-based unit compares by its factor, not by its record's id.
    expectApart(await merge([{ values: X, unit: '#4', factor: '0.3048' }, { values: X, unit: '#4', factor: '1.' }]), 2);
    expect((await merge([{ values: X, unit: '#4' }, { values: X, unit: '#4' }])).contexts).toHaveLength(1);
  });

  it('tells apart two different rigid operations', async () => {
    const rigid = (eastings: number): Georef => ({ raw: `#21=IFCRIGIDOPERATION(#14,#20,IFCLENGTHMEASURE(${eastings}.),IFCLENGTHMEASURE(1200000.),500.);` });
    expectApart(await merge([rigid(2600000), rigid(2700000)], 'IFC4X3'), 2);
    expect((await merge([rigid(2600000), rigid(2600000)], 'IFC4X3')).contexts).toHaveLength(1);
  });
});
