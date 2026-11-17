/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `IfcMapConversionScaled` is written only into a file whose FILE_SCHEMA
 * declares it. Of the schemas bundled in `packages/codegen/schemas/`, only
 * `IFC4X3.exp` (`IFC4X3_DEV_923b0514`, a post-RC development snapshot)
 * declares the entity; `IFC4_ADD2_TC1`, `IFC4X1` and `IFC4X2` do not, and no
 * `IFC4X3_RC*` schema is bundled. The exporter keeps a source FILE_SCHEMA
 * verbatim, so an `IFC4X3_RC4` file must not receive one, and neither may
 * an export that converts to IFC4.
 */

import { describe, expect, it } from 'vitest';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';
import { declaresMapConversionScaled } from './step-georeferencing.js';

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

async function parse(fileSchema: string): Promise<IfcDataStore> {
  const text = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${fileSchema}'));
ENDSEC;
DATA;
#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,(#20),#30);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#30=IFCUNITASSIGNMENT((#2));
ENDSEC;
END-ISO-10303-21;
`;
  const bytes = new TextEncoder().encode(text);
  return new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

const SCALED = {
  projectedCRS: { name: 'EPSG:2056', mapUnit: 'METRE' },
  mapConversion: { eastings: 1, northings: 2, orthogonalHeight: 3, factorX: 0.9, factorY: 0.8, factorZ: 1 },
};

describe('IfcMapConversionScaled only where FILE_SCHEMA declares it', () => {
  it('names the declaring identifiers', () => {
    expect(declaresMapConversionScaled('IFC4X3')).toBe(true);
    expect(declaresMapConversionScaled('ifc4x3_add2')).toBe(true);
    for (const id of ['IFC4X3_RC1', 'IFC4X3_RC2', 'IFC4X3_RC4', 'IFC4', 'IFC4X1', 'IFC4X2', 'IFC2X3']) {
      expect(declaresMapConversionScaled(id), id).toBe(false);
    }
  });

  it('writes it into an IFC4X3_ADD2 file', async () => {
    const result = new StepExporter(await parse('IFC4X3_ADD2')).export({ schema: 'IFC4X3', applyMutations: true, georefMutations: SCALED });
    expect(decode(result.content)).toMatch(/=IFCMAPCONVERSIONSCALED\(#20,#\d+,1\.,2\.,3\.,\$,\$,\$,0\.9,0\.8,1\.\);/);
    expect(result.stats.warnings ?? []).toEqual([]);
  });

  it('writes no factors into an IFC4X3_RC4 file, and says so', async () => {
    const result = new StepExporter(await parse('IFC4X3_RC4')).export({ schema: 'IFC4X3', applyMutations: true, georefMutations: SCALED });
    const content = decode(result.content);
    expect(content).toContain("FILE_SCHEMA(('IFC4X3_RC4'))");
    expect(content).not.toContain('IFCMAPCONVERSIONSCALED');
    expect(content).toMatch(/=IFCMAPCONVERSION\(#20,#\d+,1\.,2\.,3\.,\$,\$,\$\);/);
    expect(result.stats.warnings?.join('\n')).toMatch(/IfcMapConversionScaled.*IFC4X3_RC4/);
  });

  it('writes no factors when an IFC4X3 model is exported to IFC4, and says so', async () => {
    const result = new StepExporter(await parse('IFC4X3_ADD2')).export({ schema: 'IFC4', applyMutations: true, georefMutations: SCALED });
    const content = decode(result.content);
    expect(content).not.toContain('IFCMAPCONVERSIONSCALED');
    expect(result.stats.warnings?.join('\n')).toMatch(/IfcMapConversionScaled/);
  });
});
