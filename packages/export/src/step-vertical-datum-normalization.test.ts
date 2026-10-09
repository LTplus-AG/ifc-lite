/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EntityExtractor, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { StepExporter } from './step-exporter.js';

async function parse(text: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}
function file(verticalDatum: string, schema = 'IFC4X3_ADD2'): string {
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;
#1=IFCPROJECT('2iFPi1Pg90_94gtQu544_Z',$,'Project',$,$,$,$,(#10),#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#5=IFCUNITASSIGNMENT((#2));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,$,$);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#37=IFCPROJECTEDCRS('EPSG:32633', 'Description', 'WGS84', ${verticalDatum}, 'Transverse Mercator', '33N', $);
#38=IFCMAPCONVERSION(#10,#37,504895.063,4509260.698,722.154,1.,0.,$);
ENDSEC;\nEND-ISO-10303-21;`;
}
function attrs(store: IfcDataStore, id: number): unknown[] {
  const record = store.entityIndex.byId.get(id);
  if (!record) throw new Error(`Missing emitted entity #${id}`);
  return new EntityExtractor(store.source).extractEntity(record)?.attributes ?? [];
}
async function exported(verticalDatum: string, normalize = true, schema?: string) {
  const input = await parse(file(verticalDatum, schema));
  const result = new StepExporter(input).export({
    schema: input.schemaVersion === 'IFC4X3' ? 'IFC4X3' : 'IFC4', normalizeVerticalDatumToEgm2008: normalize,
  });
  return { input, result, output: await parse(result.content) };
}

describe('opt-in vertical datum normalization for Cesium ion (#7356)', () => {
  it('writes a free-text sea-level datum as EGM2008 height and nothing else', async () => {
    for (const schema of ['IFC4X3_ADD2', 'IFC4']) {
      const { input, result, output } = await exported("'EVRS2007'", true, schema);
      expect(result.stats.warnings).toEqual([]);
      const before = attrs(input, 37), after = attrs(output, 37);
      expect(after[3]).toBe('EPSG:3855');
      expect([...after.slice(0, 3), ...after.slice(4)]).toEqual([...before.slice(0, 3), ...before.slice(4)]);
      // Heights and the map operation are never rewritten.
      expect(attrs(output, 38)).toEqual(attrs(input, 38));
      expect(result.stats.modifiedEntityCount).toBe(1);
    }
  });

  it('preserves explicit EPSG codes, ellipsoidal datums and an omitted datum', async () => {
    for (const datum of ["'EPSG:5621'", "'epsg: 5703'", "'WGS84 ellipsoid'", "'ETRS89'", "'GRS 80'", "''", '$']) {
      const { input, result, output } = await exported(datum);
      expect(attrs(output, 37), datum).toEqual(attrs(input, 37));
      expect(result.stats.modifiedEntityCount, datum).toBe(0);
    }
  });

  it('leaves ordinary exports untouched', async () => {
    const { input, output } = await exported("'EVRS2007'", false);
    expect(attrs(output, 37)).toEqual(attrs(input, 37));
  });

  it('refuses delta and schema-converting requests', async () => {
    const input = await parse(file("'EVRS2007'"));
    expect(() => new StepExporter(input).export({ schema: 'IFC4', normalizeVerticalDatumToEgm2008: true })).toThrow(/full export/);
  });

  it('labels the real ACCA bridge datum so Cesium ion applies its geoid (#7356)', async ctx => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(new URL('../../../tests/models/buildingsmart/Viadotto_Acerno.ifc', import.meta.url)));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { ctx.skip(); return; }
      throw error;
    }
    const input = await parse(bytes);
    const crs = input.entityIndex.byType.get('IFCPROJECTEDCRS')?.[0];
    expect(crs).toBeDefined();
    expect(attrs(input, crs!)[3]).toBe('EVRS2007');
    const result = new StepExporter(input).export({ schema: 'IFC4X3', normalizeVerticalDatumToEgm2008: true });
    expect(attrs(await parse(result.content), crs!)[3]).toBe('EPSG:3855');
  });
});
