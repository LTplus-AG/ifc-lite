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
 * unit of `factor` metres, $ the project's), or, with `raw`, the given CRS and operation records instead; `projectUnit` is the model's length unit.
 */
interface Georef { values?: string; unit?: '#2' | '#3' | '#4' | '$'; factor?: string; raw?: string; projectUnit?: '#2' | '#3' }
const georefLines = ({ values, unit = '#2', factor = '0.3048', raw }: Georef) => `#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#4=IFCCONVERSIONBASEDUNIT(#5,.LENGTHUNIT.,'FOOT',#6);
#5=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#6=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${factor}),#2);
${raw ?? `#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,${unit});\n#21=IFCMAPCONVERSION(#14,#20,${values});`}`;

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

/** A projected CRS in metres, for the records `raw` replaces. */
const METRE_CRS = "#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#2);";
const X = '2600000.,1200000.,500.,1.,0.,1.';
const Y = '2700000.,1200000.,500.,1.,0.,1.';
const at = (values: string): Georef => ({ values });

/** The ids the merged IfcProject lists in RepresentationContexts. */
const projectContexts = (content: string) =>
  content.match(/^#\d+=IFCPROJECT\(.*,\((#[\d,#]*)\),#\d+\);$/m)?.[1].split(',') ?? [];

async function merge(georefs: (Georef | null)[], schema: 'IFC4' | 'IFC4X3' = 'IFC4', unitReconciliation?: 'normalize' | 'assume-shared') {
  const inputs = await Promise.all(georefs.map((georef, index) => input(String.fromCharCode(97 + index), georef, schema)));
  const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema, unitReconciliation })).content);
  const contexts: string[] = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
  const sources = [...content.matchAll(/=\s*(?:\/\*.*?\*\/\s*)?IFC(?:MAPCONVERSION(?:SCALED)?|RIGIDOPERATION)\((?:\/\*.*?\*\/\s*)?(#\d+),/g)].map(match => match[1]);
  return { contexts, sources, listed: projectContexts(content), crs: content.match(/=\s*IFCPROJECTEDCRS\(/g)?.length ?? 0, wkt: content.match(/=\s*IFCWELLKNOWNTEXT\(/g)?.length ?? 0 };
}

/** Every georeference sits on its own context, each a context of the file. */
function expectApart({ contexts, sources, listed }: Awaited<ReturnType<typeof merge>>, count: number) {
  expect(contexts).toHaveLength(count);
  // A context kept apart still belongs to the merged project.
  expect([...listed].sort()).toEqual([...contexts].sort());
  expect(sources).toHaveLength(count);
  expect(new Set(sources).size).toBe(count);
  expect(sources.every(source => contexts.includes(source))).toBe(true);
}

describe('merged STEP export and map conversions (#10798)', () => {
  it('keeps a second model with a different map conversion on its own context', async () => {
    expectApart(await merge([at(X), at(Y)]), 2);
  });

  // One rule for a kept context: it follows its own project. Model b's context is kept (its frame is moved).
  const slots = (content: string, type: string) => [...content.matchAll(new RegExp(`^#\\d+=${type}\\(.*,\\s*(\\([#\\d,\\s]*\\)|\\$)\\s*,\\s*(#\\d+|\\$)\\s*\\);$`, 'gm'))]
    .map(match => match[1] === '$' ? [] : match[1].slice(1, -1).split(',').map(ref => ref.trim()));
  for (const [owner, project, library] of [['project only', true, false], ['library only', false, true], ['both', true, true], ['neither', false, false]] as const) {
    for (const folded of [true, false]) {
      it(`a kept context listed by ${owner}, ${folded ? 'its project folded' : 'its project retained'}`, async () => {
        let b = model('b', '0ProjectB000000000000b', folded ? null : { raw: '', projectUnit: '#3' }, 'IFC4')
          .replace('#10=IFCCARTESIANPOINT((0.,0.,0.))', '#10=IFCCARTESIANPOINT((10.,0.,0.))');
        if (!project) b = b.replace(',$,$,$,$,(#14),#9);', ',$,$,$,$,$,#9);');
        if (library) b = b.replace('ENDSEC;\nEND-ISO', "#31=IFCPROJECTLIBRARY('0LibraryB000000000000b',$,'Lib',$,$,$,$,(#14),#9);\nENDSEC;\nEND-ISO");
        const bytes = new TextEncoder().encode(b);
        const inputs = [await input('a', null, 'IFC4'), { id: 'b', name: 'b', dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) }];
        const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema: 'IFC4' })).content);
        const [ownContext, keptContext] = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
        expect(keptContext, 'b keeps its moved context').toBeDefined();
        const projects = slots(content, 'IFCPROJECT'), libraries = slots(content, 'IFCPROJECTLIBRARY');
        // Folded: b's project is the primary's. Retained (federated): b keeps its own, listed as in the source.
        expect(projects).toEqual(folded
          ? [[ownContext, ...(project ? [keptContext] : [])]]
          : [[ownContext], project ? [keptContext] : []]);
        expect(libraries).toEqual(library ? [[keptContext]] : []);
      });
    }
  }

  it('counts a project that lists a subcontext as listing its root', async () => {
    const moved = model('b', '0ProjectB000000000000b', null, 'IFC4').replace('#10=IFCCARTESIANPOINT((0.,0.,0.))', '#10=IFCCARTESIANPOINT((10.,0.,0.))')
      .replace(',$,$,$,$,(#14),#9);', ',$,$,$,$,(#20),#9);')
      .replace('ENDSEC;\nEND-ISO', "#20=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#14,$,.MODEL_VIEW.,$);\nENDSEC;\nEND-ISO");
    const bytes = new TextEncoder().encode(moved);
    const inputs = [await input('a', null, 'IFC4'), { id: 'b', name: 'b', dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) }];
    const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema: 'IFC4' })).content);
    const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
    expect(contexts).toHaveLength(2);
    expect(projectContexts(content)).toContain(contexts[1]);
  });

  it('lists a context kept for a different frame in the merged project too', async () => {
    const moved = model('b', '0ProjectB000000000000b', null, 'IFC4').replace('#10=IFCCARTESIANPOINT((0.,0.,0.))', '#10=IFCCARTESIANPOINT((10.,0.,0.))');
    const bytes = new TextEncoder().encode(moved);
    const inputs = [await input('a', null, 'IFC4'), { id: 'b', name: 'b', dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) }];
    const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema: 'IFC4' })).content);
    const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
    expect(contexts).toHaveLength(2);
    expect([...projectContexts(content)].sort()).toEqual([...contexts].sort());
  });

  it('lists a kept context on the synchronous path too, and leaves a library\'s context to the library', async () => {
    const moved = model('b', '0ProjectB000000000000b', null, 'IFC4').replace('#10=IFCCARTESIANPOINT((0.,0.,0.))', '#10=IFCCARTESIANPOINT((10.,0.,0.))')
      .replace('ENDSEC;\nEND-ISO', "#30=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#13,$);\n#31=IFCPROJECTLIBRARY('0LibraryB000000000000b',$,'Lib',$,$,$,$,(#30),#9);\nENDSEC;\nEND-ISO");
    const bytes = new TextEncoder().encode(moved);
    const inputs = [await input('a', null, 'IFC4'), { id: 'b', name: 'b', dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) }];
    const content = new TextDecoder().decode(new MergedExporter(inputs).export({ schema: 'IFC4' }).content);
    const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
    const library = content.match(/^#\d+=IFCPROJECTLIBRARY\(.*,\((#\d+)\),#\d+\);$/m)?.[1];
    expect(contexts).toHaveLength(3);
    expect(library, 'the library keeps its context').toBeDefined();
    expect([...projectContexts(content)].sort()).toEqual(contexts.filter(id => id !== library).sort());
  });

  it('leaves a federated model\'s contexts on its own project, which the merge keeps', async () => {
    // A millimetre model in a metre merge is federated: its IfcProject stays, so its context is not the primary's.
    const inputs = [await input('a', null, 'IFC4'), await input('b', { raw: '', projectUnit: '#3' }, 'IFC4')];
    const content = new TextDecoder().decode((await new MergedExporter(inputs).exportAsync({ schema: 'IFC4' })).content);
    const projects = [...content.matchAll(/^#\d+=IFCPROJECT\(.*,\((#[\d,#]*)\),#\d+\);$/gm)].map(match => match[1].split(','));
    const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
    expect(projects).toHaveLength(2);
    expect(projects.map(listed => listed.length)).toEqual([1, 1]);
    expect(projects.flat().sort()).toEqual([...contexts].sort());
  });

  it('keeps one conversion and one CRS on a context two models share the georeference of (#10873)', async () => {
    for (const georefs of [[at(X), at(X)], [null, at(X), at(X)], [at(X), null, at(X)], [at(X), at(X), at(X)]]) {
      const { contexts, sources, crs } = await merge(georefs);
      expect(contexts, JSON.stringify(georefs)).toHaveLength(1);
      expect(sources, 'HasCoordinateOperation is SET [0:1]').toEqual(contexts);
      expect(crs).toBe(1);
    }
    // The shared georeference stays one when a different one arrives after it.
    expectApart(await merge([at(X), at(X), at(Y)]), 2);
  });

  it('merges a georeference only when every attribute is equal, so no CRS data is lost (#10873)', async () => {
    const described = (description: string): Georef => ({ raw: `#20=IFCPROJECTEDCRS('EPSG:2056','${description}',$,$,$,$,#2);\n#21=IFCMAPCONVERSION(#14,#20,${X});` });
    const merged = await merge([described('LV95'), described('LV95 (survey 2024)')]);
    expectApart(merged, 2);
    expect(merged.crs).toBe(2);
    expect((await merge([described('LV95'), described('LV95')])).crs).toBe(1);
  });

  it('keeps one WKT on the shared CRS, and leaves an operation into another context alone (#10873)', async () => {
    const withWkt: Georef = { raw: `${METRE_CRS}\n#21=IFCMAPCONVERSION(#14,#20,${X});\n#22=IFCWELLKNOWNTEXT('PROJCS["CH1903+ / LV95"]',#20);` };
    const wkt = await merge([withWkt, withWkt], 'IFC4X3');
    expect([wkt.sources.length, wkt.crs, wkt.wkt]).toEqual([1, 1, 1]);
    // IFC4X3 lets an operation's TargetCRS be another context: B's plan context, in its own frame, stays B's.
    const planAt = (x: string): Georef => ({ raw: `#15=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-05,#16,$);
#16=IFCAXIS2PLACEMENT2D(#17,$);
#17=IFCCARTESIANPOINT((${x},0.));
#21=IFCRIGIDOPERATION(#14,#15,IFCLENGTHMEASURE(10.),IFCLENGTHMEASURE(20.),0.);` });
    // Two operations into contexts cannot be told equal, so B's model context stays apart with its own operation.
    const plans = await merge([planAt('0.'), planAt('500.')], 'IFC4X3');
    expect(plans.contexts).toHaveLength(4);
    // Both operations survive, each on its own model context.
    expect(plans.sources).toEqual([plans.contexts[0], plans.contexts[2]]);
    // B's model context, kept apart, is listed in the merged project; the plan contexts were never listed.
    expect(plans.listed).toEqual([plans.contexts[0], plans.contexts[2]]);
  });

  it('still unifies two models with the same map conversion, or where only one is georeferenced', async () => {
    expect((await merge([at(X), at(X)])).contexts).toHaveLength(1);
    expect((await merge([at(X), null])).contexts).toHaveLength(1);
    expect((await merge([null, at(X)])).contexts).toHaveLength(1);
  });

  it('checks each later model against a georeference an earlier one gave the shared context', async () => {
    // The primary has none, so the second model's conversion lands on its context: the third's must agree with it.
    expectApart(await merge([null, at(X), at(Y)]), 2);
  });

  it('tells apart the same numbers in different map units', async () => {
    expectApart(await merge([at(X), { values: X, unit: '#3' }]), 2);
    // A CRS without a map unit uses the project's.
    expectApart(await merge([{ values: X, unit: '$' }, { values: X, unit: '$', projectUnit: '#3' }], 'IFC4', 'normalize'), 2);
    expect((await merge([{ values: X, unit: '$' }, { values: X, unit: '$' }])).contexts).toHaveLength(1);
    // Under assume-shared the caller says every model is in the primary's unit, so the map unit is the primary's too.
    expect((await merge([{ values: X, unit: '$' }, { values: X, unit: '$', projectUnit: '#3' }], 'IFC4', 'assume-shared')).contexts).toHaveLength(1);
    // Two spellings of one georeference (an explicit metre and the project's metre, an omitted and a unit scale) are
    // not equal records, so neither is dropped: each keeps its own context and operation (#10873).
    expectApart(await merge([at(X), { values: X, unit: '$' }]), 2);
    expectApart(await merge([at(X), at('2600000.,1200000.,500.,$,$,$')]), 2);
    // A conversion-based unit compares by its factor, not by its record's id.
    expectApart(await merge([{ values: X, unit: '#4', factor: '0.3048' }, { values: X, unit: '#4', factor: '1.' }]), 2);
    expect((await merge([{ values: X, unit: '#4' }, { values: X, unit: '#4' }])).contexts).toHaveLength(1);
  });

  it('tells apart two different rigid operations', async () => {
    const rigid = (eastings: number): Georef => ({ raw: `${METRE_CRS}
#21=IFCRIGIDOPERATION(#14,#20,IFCLENGTHMEASURE(${eastings}.),IFCLENGTHMEASURE(1200000.),500.);` });
    expectApart(await merge([rigid(2600000), rigid(2700000)], 'IFC4X3'), 2);
    const same = await merge([rigid(2600000), rigid(2600000)], 'IFC4X3');
    expect([same.contexts.length, same.sources.length, same.crs]).toEqual([1, 1, 1]);
  });

  it('tells apart two scaled conversions with different factors', async () => {
    const scaled = (factorX: string): Georef => ({ raw: `${METRE_CRS}
#21=IFCMAPCONVERSIONSCALED(#14,#20,${X},${factorX},1.,1.);` });
    expectApart(await merge([scaled('1.'), scaled('2.')], 'IFC4X3'), 2);
    expect((await merge([scaled('1.'), scaled('1.')], 'IFC4X3')).contexts).toHaveLength(1);
  });

  it('keeps apart a georeference it cannot compare', async () => {
    // A conversion the parser refuses (an eastings no number holds) is no evidence the two agree.
    expectApart(await merge([at(X), at('1.E400,1200000.,500.,1.,0.,1.')]), 2);
    // A comment around the SourceCRS reference does not hide the operation.
    expectApart(await merge([at(X), { raw: `${METRE_CRS}\n#21=IFCMAPCONVERSION(/* source */ #14,#20,${Y});` }]), 2);
    expectApart(await merge([at(X), { raw: `${METRE_CRS}\n#21=/* operation */IFCMAPCONVERSION(#14,#20,${Y});` }]), 2);
    expectApart(await merge([at(X), { raw: `${METRE_CRS}\n#21=IFCMAPCONVERSION(#14,#20,${Y}) /* c */;` }]), 2);
    expectApart(await merge([at(X), { raw: `${METRE_CRS}\n#21/* id */ = IFCMAPCONVERSION(#14,#20,${Y}) /* end */;` }]), 2);
    // A geographic CRS's height unit is not read, so two of them are never taken as one.
    const geographic: Georef = { raw: `#20=IFCGEOGRAPHICCRS('WGS84',$,'WGS84',$,$,$,$);
#21=IFCRIGIDOPERATION(#14,#20,IFCPLANEANGLEMEASURE(8.5),IFCPLANEANGLEMEASURE(47.3),500.);` };
    expectApart(await merge([geographic, geographic], 'IFC4X3'), 2);
  });
});
