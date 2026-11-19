/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Merged export applies each model's georeference edits, as single-model export does (#10669). */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';
import { mergeWarningLabel } from './merged-bake.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

const model = (name: string, project: string) => `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('${name}.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('${project}',$,'${name}',$,$,$,$,(#14),#9);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCUNITASSIGNMENT((#2));
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCDIRECTION((0.,0.,1.));
#12=IFCDIRECTION((1.,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#10,#11,#12);
#14=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#13,$);
ENDSEC;
END-ISO-10303-21;
`;

async function parse(text: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

const GEOREF: MergeModelInput['georefMutations'] = {
  projectedCRS: { name: 'EPSG:2056', description: 'CH1903+ / LV95', geodeticDatum: 'CH1903+', mapUnit: 'METRE' },
  mapConversion: { eastings: 2600000, northings: 1200000, orthogonalHeight: 500, xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1 },
};

describe('MergedExporter georeference edits (#10669)', () => {
  it('writes a model\'s georeference edits into the merged file', async () => {
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: GEOREF };
    const b: MergeModelInput = { id: 'b', name: 'B', dataStore: await parse(model('B', '0ProjectB000000000000b')) };
    const content = decode((await new MergedExporter([a, b]).exportAsync({ schema: 'IFC4' })).content);
    expect(content).toContain("IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+'");
    expect(content).toMatch(/IFCMAPCONVERSION\(#\d+,#\d+,2600000\.,1200000\.,500\.,1\.,0\.,1\.\);/);
  });

  it('refuses georeference edits on the synchronous path, which cannot bake them', async () => {
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: GEOREF };
    expect(() => new MergedExporter([a]).export({ schema: 'IFC4' })).toThrow(/exportAsync/);
  });

  it('treats an empty georeference edit as no edit', async () => {
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: {} };
    const content = decode(new MergedExporter([a]).export({ schema: 'IFC4' }).content);
    expect(content).not.toContain('IFCMAPCONVERSION');
  });
});

describe('MergedExporter georeference edits it cannot write (#10669)', () => {
  it('merges without an edit the exporter refuses, and names it in the warnings', async () => {
    // A new CRS with a partial position: the exporter refuses rather than guess the missing fields as 0.
    const partial: MergeModelInput['georefMutations'] = { projectedCRS: GEOREF?.projectedCRS, mapConversion: { eastings: 1, northings: 2 } };
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: partial };
    const result = await new MergedExporter([a]).exportAsync({ schema: 'IFC4' });
    expect(decode(result.content)).not.toContain('IFCMAPCONVERSION');
    expect(result.stats.warnings.some(warning => /^A: Georeferencing edits were not written\. Georeferencing was not exported: .*partial edit/.test(warning))).toBe(true);
  });

  it('writes an IFC2X3 model\'s edits into an IFC4 merge, as single-model export does', async () => {
    const ifc2x3 = model('A', '0ProjectA000000000000a').replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))");
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(ifc2x3), georefMutations: GEOREF };
    const result = await new MergedExporter([a]).exportAsync({ schema: 'IFC4' });
    expect(decode(result.content)).toMatch(/IFCMAPCONVERSION\(#\d+,#\d+,2600000\.,1200000\.,500\.,1\.,0\.,1\.\);/);
    expect(result.stats.warnings).toEqual([]);
  });

  it('applies an IFC2X3 model\'s pending edits and georeference edits together in an IFC4 merge', async () => {
    const store = await parse(model('A', '0ProjectA000000000000a').replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))"));
    const view = new MutablePropertyView(store.properties, 'a');
    view.setAttribute(1, 'Name', 'Renamed project');
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: store, mutationView: view, georefMutations: GEOREF };
    const content = decode((await new MergedExporter([a]).exportAsync({ schema: 'IFC4' })).content);
    expect(content).toContain("'Renamed project'");
    expect(content).toMatch(/IFCMAPCONVERSION\(#\d+,#\d+,2600000\./);
  });

  it('names an edit the exporter wrote only in part', async () => {
    // A position with no CRS to target: the exporter writes nothing and says so.
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: { mapConversion: { eastings: 2600000 } } };
    const result = await new MergedExporter([a]).exportAsync({ schema: 'IFC4' });
    expect(result.stats.warnings.some(warning => /^A: Cannot create IfcMapConversion/.test(warning))).toBe(true);
  });

  it('leaves georeference edits out of an IFC2X3 merge, which has no IfcMapConversion', async () => {
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(model('A', '0ProjectA000000000000a')), georefMutations: GEOREF };
    const result = await new MergedExporter([a]).exportAsync({ schema: 'IFC2X3' });
    expect(decode(result.content)).not.toContain('IFCMAPCONVERSION');
    expect(result.stats.warnings.some(warning => /A: Georeferencing edits were not written.*IFC2X3/.test(warning))).toBe(true);
  });
});

describe('MergedExporter georeference warnings for models with one name (#10669)', () => {
  it('names each model when two share a name, so both refusals are reported', async () => {
    const a: MergeModelInput = { id: 'a', name: 'Same', dataStore: await parse(model('Same', '0ProjectA000000000000a')), georefMutations: GEOREF };
    const b: MergeModelInput = { id: 'b', name: 'Same', dataStore: await parse(model('Same', '0ProjectB000000000000b')), georefMutations: GEOREF };
    const result = await new MergedExporter([a, b]).exportAsync({ schema: 'IFC2X3' });
    const refusals = result.stats.warnings.filter(warning => /Georeferencing edits were not written/.test(warning));
    expect(refusals.map(warning => warning.split(':')[0])).toEqual(['Same (a)', 'Same (b)']);
  });
  it('keeps the labels distinct when a model is named like another\'s qualified label', async () => {
    const inputs: MergeModelInput[] = await Promise.all([['a', 'Same'], ['b', 'Same'], ['c', 'Same (a)']].map(async ([id, name]) => (
      { id, name, dataStore: await parse(model(name, `0Project${id.toUpperCase()}000000000000${id}`)), georefMutations: GEOREF })));
    const result = await new MergedExporter(inputs).exportAsync({ schema: 'IFC2X3' });
    const refusals = result.stats.warnings.filter(warning => /Georeferencing edits were not written/.test(warning));
    expect(refusals.map(warning => warning.slice(0, warning.indexOf(': Georef')))).toEqual(['Same (a)', 'Same (b)', 'Same (a) (c)']);
  });
});

describe('MergedExporter normalize warnings for models with one name (#10669)', () => {
  it('names each normalized model, so both caveats are reported', async () => {
    // Millimetre models with a map conversion are normalized into the metre primary, and each gets a caveat.
    const millimetre = (project: string) => model('Same', project).replace('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)', 'IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)')
      .replace('ENDSEC;\nEND-ISO', "#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,$);\n#21=IFCMAPCONVERSION(#14,#20,0.,0.,0.,1.,0.,1.);\nENDSEC;\nEND-ISO");
    const inputs: MergeModelInput[] = [
      { id: 'p', name: 'Primary', dataStore: await parse(model('Primary', '0ProjectP000000000000p')) },
      { id: 'a', name: 'Same', dataStore: await parse(millimetre('0ProjectA000000000000a')) },
      { id: 'b', name: 'Same', dataStore: await parse(millimetre('0ProjectB000000000000b')) },
    ];
    const result = await new MergedExporter(inputs).exportAsync({ schema: 'IFC4', unitReconciliation: 'normalize' });
    const caveats = result.stats.warnings.filter(warning => /carries georeferencing/.test(warning));
    expect(caveats.map(warning => warning.split('"')[1])).toEqual(['Same (a)', 'Same (b)']);
  });
});

describe('mergeWarningLabel (#10669)', () => {
  const labels = (models: { id: string; name: string }[]) => models.map(entry => mergeWarningLabel(entry, models));
  it('gives every model a distinct label, whatever the names and ids', () => {
    const sets = [
      [{ id: 'a', name: 'Same' }, { id: 'b', name: 'Same' }, { id: 'c', name: 'Same (a)' }, { id: 'd', name: 'Same (a) (c)' }],
      [{ id: 'b (c)', name: 'A' }, { id: 'z', name: 'A' }, { id: 'c)', name: 'A (b' }, { id: 'w', name: 'A (b' }],
      [{ id: 'x', name: 'A (b)' }, { id: 'y', name: 'A (b)' }, { id: 'b) (x', name: 'A' }, { id: 'v', name: 'A' }],
      [{ id: 'q"', name: 'A' }, { id: 'r', name: 'A' }, { id: 's', name: 'A ("q\\"")' }],
      [{ id: ' (', name: 'A' }, { id: 'z', name: 'A' }, { id: '"', name: 'A ("' }, { id: 'w', name: 'A ("' }],
    ];
    for (const models of sets) expect(new Set(labels(models)).size, JSON.stringify(labels(models))).toBe(models.length);
    expect(labels([{ id: 'a', name: 'House' }, { id: 'b', name: 'Terrain' }])).toEqual(['House', 'Terrain']);
  });
});
