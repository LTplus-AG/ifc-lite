/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { EntityExtractor, IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { StepExporter } from './step-exporter.js';

const body = `
#1=IFCPROJECT('2iFPi1Pg90_94gtQu544_Z',$,'Project',$,$,$,$,(#10),#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#5=IFCUNITASSIGNMENT((#2));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#9,$);
#37=IFCPROJECTEDCRS('EPSG:32760',$,$,$,$,$,#2);
#38=IFCMAPCONVERSION(#10,#37,729011225.8823584,9063960607.644705,3000.,0.,1.,$);
`;
async function parse(text: string | Uint8Array): Promise<IfcDataStore> {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return new IfcParser().parseColumnar(bytes.slice().buffer as ArrayBuffer, { disableWorkerScan: true });
}
function file(data: string, schema = 'IFC4'): string {
  return `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;${data}\nENDSEC;\nEND-ISO-10303-21;`;
}
function attrs(store: IfcDataStore, id: number) {
  const record = store.entityIndex.byId.get(id);
  if (!record) throw new Error(`Missing emitted entity #${id}`);
  const entity = new EntityExtractor(store.source).extractEntity(record);
  if (!entity) throw new Error(`Unreadable emitted entity #${id}`);
  return entity.attributes;
}
async function exported(store: IfcDataStore, view?: MutablePropertyView) {
  const result = new StepExporter(store, view).export({ schema: store.schemaVersion === 'IFC4X3' ? 'IFC4X3' : 'IFC4', normalizeMapUnitsToMetres: true });
  return { result, store: await parse(result.content) };
}
function expectPhysicalMapEqual(before: unknown[], after: unknown[], factor: number) {
  // This is the IFC similarity contract, evaluated at independent nonzero
  // local engineering coordinates; checking offsets alone misses lost scale.
  for (const point of [[0, 0, 0], [1800, -2700, 4900], [-991, 213, 778]]) {
    const transform = (a: unknown[], unit: number) => {
      const x = Number(a[5] ?? 1), y = Number(a[6] ?? 0), norm = Math.hypot(x, y);
      const scale = Number(a[7] ?? 1);
      const px = point[0] * Number(a[8] ?? 1), py = point[1] * Number(a[9] ?? 1), pz = point[2] * Number(a[10] ?? 1);
      return [unit * (Number(a[2]) + scale * (x * px - y * py) / norm),
        unit * (Number(a[3]) + scale * (y * px + x * py) / norm),
        unit * (Number(a[4]) + scale * pz)];
    };
    const original = transform(before, factor), normalized = transform(after, 1);
    normalized.forEach((value, axis) => {
      // Scale-then-add and add-then-scale differ by a few f64 ULPs at map
      // magnitudes. This bound is arithmetic precision, not a geodesy budget.
      expect(Math.abs(value - original[axis])).toBeLessThanOrEqual(Math.max(1e-8, 4 * Number.EPSILON * Math.abs(original[axis])));
    });
  }
}

describe('opt-in emitted map-unit normalization (#6587)', () => {
  it('preserves physical map coordinates, omitted Scale, and shared millimetre project units', async () => {
    const input = await parse(file(body));
    const { result, store } = await exported(input);
    expect(result.stats.warnings).toEqual([]);
    expect(attrs(store, 2)).toEqual(attrs(input, 2));
    expect(attrs(store, 5)).toEqual(attrs(input, 5));
    expect(attrs(store, 6)).toEqual(attrs(input, 6));
    expect(attrs(store, 38).slice(5)).toEqual([0, 1, 0.001]);
    const metre = Number(attrs(store, 37)[6]);
    expect(metre).not.toBe(2);
    expect(attrs(store, metre).slice(1)).toEqual(['.LENGTHUNIT.', null, '.METRE.']);
    expectPhysicalMapEqual(attrs(input, 38), attrs(store, 38), 0.001);
    expect(result.stats.modifiedEntityCount).toBe(2);
    expect(result.stats.newEntityCount).toBe(1);
    expect(attrs(input, 38)[7]).toBeNull();
    const ordinary = await parse(new StepExporter(input).export({ schema: 'IFC4' }).content);
    expect(attrs(ordinary, 37)).toEqual(attrs(input, 37));
    expect(attrs(ordinary, 38)).toEqual(attrs(input, 38));
  });

  it('sees effective named, positional and generated georeferencing edits without modifying the overlay', async () => {
    const input = await parse(file(body));
    const view = new MutablePropertyView(input.properties ?? null, 'geo');
    view.setAttribute(38, 'Eastings', '800000000', '729011225.8823584');
    view.setPositionalAttribute(38, 2, 810000000);
    const result = new StepExporter(input, view).export({ schema: 'IFC4', normalizeMapUnitsToMetres: true,
      georefMutations: { mapConversion: { scale: 2 } } });
    const output = await parse(result.content);
    expect(attrs(output, 38)[2]).toBe(810000);
    expect(attrs(output, 38)[7]).toBe(0.002);
    expect(view.getPositionalMutationsForEntity(38)?.get(2)).toBe(810000000);
    const fresh = await parse(file(body.slice(0, body.indexOf('#37='))));
    const generated = new StepExporter(fresh).export({ schema: 'IFC4', normalizeMapUnitsToMetres: true,
      georefMutations: { projectedCRS: { name: 'EPSG:32760', mapUnit: 'MILLIMETRE' },
        mapConversion: { eastings: 700000000, northings: 9000000000, scale: 1 } } });
    const out = await parse(generated.content);
    const id = out.entityIndex.byType.get('IFCMAPCONVERSION')![0];
    expect(attrs(out, id).slice(2, 5)).toEqual([700000, 9000000, 0]);
    expect(attrs(out, id)[7]).toBe(0.001);
    expect(generated.stats.warnings).toEqual([]);
  });

  it('includes overlay-created CRS/conversions and reuses one fresh metre unit across contexts', async () => {
    const input = await parse(file(body));
    const view = new MutablePropertyView(input.properties ?? null, 'created');
    view.setExpressIdWatermark(38);
    const crs = view.createEntity('IfcProjectedCRS', ['EPSG:32760', null, null, null, null, null, '#2']);
    const operation = view.createEntity('IfcMapConversion', ['#10', `#${crs.expressId}`, 3000, 4000, 5000, 1, 0, 2]);
    const { result, store } = await exported(input, view);
    expect(result.stats.warnings).toEqual([]);
    expect(attrs(store, operation.expressId).slice(2)).toEqual([3, 4, 5, 1, 0, 0.002]);
    expect(attrs(store, crs.expressId)[6]).toBe(attrs(store, 37)[6]);
    expect(view.getNewEntity(operation.expressId)?.attributes[7]).toBe(2);
    expect(result.stats.newEntityCount).toBe(3);
  });

  it('normalizes every conversion sharing a CRS and preserves MapConversionScaled factors', async () => {
    const input = await parse(file(body.replace('IFCMAPCONVERSION(', 'IFCMAPCONVERSIONSCALED(')
      .replace('0.,1.,$);', '0.,1.,2.,3.,4.,5.);') + '#39=IFCMAPCONVERSION(#10,#37,4000.,5000.,6000.,1.,0.,1.);', 'IFC4X3'));
    const { result, store } = await exported(input);
    expect(attrs(store, 38).slice(7)).toEqual([0.002, 3, 4, 5]);
    expectPhysicalMapEqual(attrs(input, 38), attrs(store, 38), 0.001);
    expect(attrs(store, 39).slice(2)).toEqual([4, 5, 6, 1, 0, 0.001]);
    expect(result.stats.modifiedEntityCount).toBe(3);
    expect(result.stats.newEntityCount).toBe(1);
  });

  it('resolves absent MapUnit through the owning project context and refuses ambiguous ownership', async () => {
    const missing = body.replace("$,$,$,#2);", "$,$,$,$);");
    const input = await parse(file(missing));
    const normalized = await exported(input);
    expect(attrs(normalized.store, 38)[7]).toBe(0.001);
    const ambiguous = await parse(file(missing + "#40=IFCPROJECT('0jFPi1Pg90_94gtQu544_Z',$,'Other',$,$,$,$,(#10),#5);"));
    const refused = await exported(ambiguous);
    expect(refused.result.stats.warnings.some(w => w.includes('ambiguous'))).toBe(true);
    expect(attrs(refused.store, 37)).toEqual(attrs(ambiguous, 37));
    expect(attrs(refused.store, 38)).toEqual(attrs(ambiguous, 38));
  });

  it('reads units written with spaces after commas, as ACCA usBIM emits them (#7335)', async () => {
    const spaced = (text: string) => text.replace(/,(?=\S)/g, ', ');
    // Metre project with omitted MapUnit: already metres, nothing to refuse.
    const metre = spaced(body.replace('.MILLI.', '$').replace('$,$,$,#2);', '$,$,$,$);'));
    const plain = await exported(await parse(file(metre)));
    expect(plain.result.stats.warnings).toEqual([]);
    const input = await parse(file(spaced(body)));
    const normalized = await exported(input);
    expect(normalized.result.stats.warnings).toEqual([]);
    expectPhysicalMapEqual(attrs(input, 38), attrs(normalized.store, 38), 0.001);
  });

  it('refuses unsupported consumers atomically without changing the shared CRS', async () => {
    const input = await parse(file(body + '#39=IFCRIGIDOPERATION(#10,#37,IFCLENGTHMEASURE(1.),IFCLENGTHMEASURE(2.),3.);', 'IFC4X3'));
    const { result, store } = await exported(input);
    expect(result.stats.warnings.some(w => w.includes('not an IfcMapConversion'))).toBe(true);
    expect(attrs(store, 37)).toEqual(attrs(input, 37));
    expect(attrs(store, 38)).toEqual(attrs(input, 38));
  });

  it('reports unsupported coordinate-reference targets rather than silently skipping them', async () => {
    const source = body.replace('(#10,#37,', '(#10,#51,')
      + "#51=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$);";
    const input = await parse(file(source, 'IFC4X3')); const { result, store } = await exported(input);
    expect(result.stats.warnings.some(w => w.includes('not a retained IfcProjectedCRS'))).toBe(true);
    expect(attrs(store, 38)).toEqual(attrs(input, 38));
  });

  it.each(['UNKNOWN', 'FOOT'])('uses the declared conversion factor rather than a guessed %s name', async name => {
    const source = body.replace("$,$,$,#2);", "$,$,$,#43);")
      + `#41=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);\n#42=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#44);\n#43=IFCCONVERSIONBASEDUNIT(#41,.LENGTHUNIT.,'${name}',#42);\n#44=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);`;
    const input = await parse(file(source)); const { result, store } = await exported(input);
    expect(result.stats.warnings).toEqual([]);
    expect(attrs(store, 37)[6]).toBe(44);
    expect(attrs(store, 38)[7]).toBe(0.3048);
    expectPhysicalMapEqual(attrs(input, 38), attrs(store, 38), 0.3048);
  });

  it('refuses cyclic conversion units and invalid map scales without partial normalization', async () => {
    const cyclic = body.replace("$,$,$,#2);", "$,$,$,#43);") + "#41=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);#42=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(1.),#43);#43=IFCCONVERSIONBASEDUNIT(#41,.LENGTHUNIT.,'loop',#42);";
    for (const data of [cyclic, body.replace('0.,1.,$);', '0.,1.,-1.);')]) {
      const input = await parse(file(data)); const { result, store } = await exported(input);
      expect(result.stats.warnings.length).toBeGreaterThan(0);
      expect(attrs(store, 37)).toEqual(attrs(input, 37));
      expect(attrs(store, 38)).toEqual(attrs(input, 38));
    }
  });

  it('refuses retained WKT unit definitions and invalid REAL lexemes instead of guessing', async () => {
    const cases = [
      body.replace("'EPSG:32760'", "'PROJCRS[arbitrary]'"),
      body + "#45=IFCWELLKNOWNTEXT('PROJCRS[arbitrary]',#37);",
      body.replace('3000.,0.,1.,$);', ',0.,1.,$);'),
      body.replace('3000.,0.,1.,$);', '0x10,0.,1.,$);'),
    ];
    for (const data of cases) {
      const input = await parse(file(data, 'IFC4X3')); const { result, store } = await exported(input);
      expect(result.stats.warnings.length).toBeGreaterThan(0);
      expect(attrs(store, 37)).toEqual(attrs(input, 37));
      expect(attrs(store, 38)).toEqual(attrs(input, 38));
    }
  });

  it('rejects delta/schema-converting requests instead of pretending to normalize them', async () => {
    const store = await parse(file(body));
    expect(() => new StepExporter(store).export({ schema: 'IFC4', deltaOnly: true, normalizeMapUnitsToMetres: true })).toThrow('full export');
    expect(() => new StepExporter(store).export({ schema: 'IFC4X3', normalizeMapUnitsToMetres: true })).toThrow('source IFC4');
  });

  it('normalizes real SketchUp 2024 Infra-Bridge map millimetres while retaining geometry (#6587)', async ctx => {
    let source: Uint8Array;
    try { source = new Uint8Array(await readFile(new URL('../../../tests/models/buildingsmart/Infra-Bridge.ifc', import.meta.url))); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { ctx.skip('Fixture missing; run pnpm fixtures'); return; }
      throw error;
    }
    const input = await parse(source); const { result, store } = await exported(input);
    const id = input.entityIndex.byType.get('IFCMAPCONVERSION')![0];
    expectPhysicalMapEqual(attrs(input, id), attrs(store, id), 0.001);
    expect(attrs(store, id)[7]).toBe(0.001);
    const originalProject = input.entityIndex.byType.get('IFCPROJECT')![0];
    expect(attrs(store, originalProject)).toEqual(attrs(input, originalProject));
    for (const [id, record] of input.entityIndex.byId) {
      if (['IFCCARTESIANPOINT', 'IFCLOCALPLACEMENT', 'IFCEXTRUDEDAREASOLID', 'IFCRECTANGLEPROFILEDEF'].includes(record.type)) {
        expect(attrs(store, id)).toEqual(attrs(input, id));
      }
    }
    expect(result.stats.warnings).toEqual([]);
  });
});
