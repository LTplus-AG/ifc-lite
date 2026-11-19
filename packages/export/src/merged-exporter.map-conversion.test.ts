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

const model = (name: string, project: string, conversion: string | null) => `ISO-10303-21;
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
${conversion === null ? '' : `#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#2);\n#21=IFCMAPCONVERSION(#14,#20,${conversion});`}
ENDSEC;
END-ISO-10303-21;
`;

async function input(id: string, conversion: string | null): Promise<MergeModelInput> {
  const bytes = new TextEncoder().encode(model(id, `0Project${id.toUpperCase()}000000000000${id}`, conversion));
  return { id, name: id, dataStore: await new IfcParser().parseColumnar(bytes.buffer.slice(0) as ArrayBuffer) };
}

async function merge(a: string | null, b: string | null) {
  const content = new TextDecoder().decode((await new MergedExporter([await input('a', a), await input('b', b)]).exportAsync({ schema: 'IFC4' })).content);
  const contexts = content.match(/^#\d+(?==IFCGEOMETRICREPRESENTATIONCONTEXT\()/gm) ?? [];
  const sources = [...content.matchAll(/=IFCMAPCONVERSION\((#\d+),/g)].map(match => match[1]);
  return { contexts, sources };
}

describe('merged STEP export and map conversions (#10798)', () => {
  it('keeps a second model with a different map conversion on its own context', async () => {
    const { contexts, sources } = await merge('2600000.,1200000.,500.,1.,0.,1.', '2700000.,1200000.,500.,1.,0.,1.');
    expect(contexts).toHaveLength(2);
    expect(sources).toHaveLength(2);
    expect(new Set(sources).size).toBe(2);
    expect(sources.every(source => contexts.includes(source))).toBe(true);
  });

  it('still unifies two models with the same map conversion, or where only one is georeferenced', async () => {
    expect((await merge('2600000.,1200000.,500.,1.,0.,1.', '2600000.,1200000.,500.,1.,0.,1.')).contexts).toHaveLength(1);
    expect((await merge('2600000.,1200000.,500.,1.,0.,1.', null)).contexts).toHaveLength(1);
    expect((await merge(null, '2600000.,1200000.,500.,1.,0.,1.')).contexts).toHaveLength(1);
  });
});
