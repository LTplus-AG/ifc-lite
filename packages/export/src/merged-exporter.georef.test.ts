/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Merged export applies each model's georeference edits, as single-model export does (#10669). */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MergedExporter, type MergeModelInput } from './merged-exporter.js';

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
    // The exporter refuses georeference edits on an IFC2X3 source, which has no IfcMapConversion to write.
    const ifc2x3 = model('A', '0ProjectA000000000000a').replace("FILE_SCHEMA(('IFC4'))", "FILE_SCHEMA(('IFC2X3'))");
    const a: MergeModelInput = { id: 'a', name: 'A', dataStore: await parse(ifc2x3), georefMutations: GEOREF };
    const result = await new MergedExporter([a]).exportAsync({ schema: 'IFC4' });
    expect(decode(result.content)).not.toContain('IFCMAPCONVERSION');
    expect(result.stats.warnings.some(warning => /^A: Georeferencing edits were not written.*requires IFC4/.test(warning))).toBe(true);
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
