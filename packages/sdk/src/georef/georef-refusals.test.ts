/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef` refusals: every write that would need a guess, has nothing
 * to anchor to, or would leave contradicting values is refused, names the
 * input it needs, and leaves the session untouched.
 */

import { describe, expect, it } from 'vitest';
import { openModel, type HeadlessModelSession } from '../headless.js';
import { BimContext } from '../context.js';
import { GeoreferencingError, type GeoreferencingSetInput } from './types.js';

function step(schema: string, data: string): Uint8Array {
  return new TextEncoder().encode(`ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('t.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('${schema}'));
ENDSEC;
DATA;
${data}
ENDSEC;
END-ISO-10303-21;
`);
}

const UNITS = `#90=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#91=IFCUNITASSIGNMENT((#90));`;
const WITH_CONTEXT = `#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,(#5),#91);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);
#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
${UNITS}`;
const NO_CONTEXT = `#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,$,#91);
${UNITS}`;

const VALID: GeoreferencingSetInput = {
  ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
  MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
};

async function open(schema: string, data: string): Promise<HeadlessModelSession> {
  return openModel(step(schema, data), { disableWorkerScan: true });
}

function refusal(fn: () => unknown): GeoreferencingError {
  try {
    fn();
  } catch (err) {
    if (err instanceof GeoreferencingError) return err;
    throw err;
  }
  throw new Error('expected a GeoreferencingError');
}

/** Run `fn`, expect a refusal, and check the session holds nothing afterwards. */
function refusedCleanly(model: HeadlessModelSession, fn: () => unknown): GeoreferencingError {
  // FILE_NAME carries the export time, which may tick between the two exports.
  const exported = () => String(model.bim.export.ifc()).replace(/FILE_NAME\([^;]*\);/, 'FILE_NAME();');
  const before = exported();
  const err = refusal(fn);
  expect(model.bim.georef.get().pending).toBe(false);
  expect(exported()).toBe(before);
  return err;
}

describe('bim.georef refusals', () => {
  it('refuses without an IfcGeometricRepresentationContext to anchor to', async () => {
    const model = await open('IFC4', NO_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set(VALID));
      expect(err.code).toBe('NO_ANCHOR');
      expect(err.missing).toEqual(['IfcGeometricRepresentationContext']);
    } finally { model.close(); }
  });

  it('names every missing mandatory input at once', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set({
        ProjectedCRS: {} as GeoreferencingSetInput['ProjectedCRS'],
        MapConversion: { Eastings: 1 } as GeoreferencingSetInput['MapConversion'],
      }));
      expect(err.code).toBe('MISSING_INPUT');
      expect(err.missing).toEqual(['ProjectedCRS.Name', 'MapConversion.Northings', 'MapConversion.OrthogonalHeight']);
    } finally { model.close(); }
  });

  it('never assumes a map unit', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set({ ...VALID, ProjectedCRS: { Name: 'EPSG:2056' } }));
      expect(err.code).toBe('MISSING_INPUT');
      expect(err.missing).toEqual(['ProjectedCRS.MapUnit']);
      expect(err.message).toContain('does not guess');
    } finally { model.close(); }
  });

  it('refuses a map unit the writer cannot express instead of writing metres', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set({ ...VALID, ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'DEGREE' } }));
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.missing).toEqual(['ProjectedCRS.MapUnit']);
    } finally { model.close(); }
  });

  it.each([
    ['an angle that disagrees with the vector', { MapConversion: { ...VALID.MapConversion, XAxisAbscissa: 1, XAxisOrdinate: 0 }, rotationDegrees: 10 }, 'CONTRADICTION'],
    ['half a vector', { MapConversion: { ...VALID.MapConversion, XAxisAbscissa: 1 } }, 'MISSING_INPUT'],
    ['the zero vector', { MapConversion: { ...VALID.MapConversion, XAxisAbscissa: 0, XAxisOrdinate: 0 } }, 'INVALID_INPUT'],
    ['a zero scale', { MapConversion: { ...VALID.MapConversion, Scale: 0 } }, 'INVALID_INPUT'],
    ['a non-finite easting', { MapConversion: { ...VALID.MapConversion, Eastings: Number.NaN } }, 'INVALID_INPUT'],
  ] as const)('refuses %s', async (_name, patch, code) => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      expect(refusedCleanly(model, () => model.bim.georef.set({ ...VALID, ...patch } as GeoreferencingSetInput)).code).toBe(code);
    } finally { model.close(); }
  });

  it('accepts an angle and a vector that agree, and writes the vector as given', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      const result = model.bim.georef.set({
        ...VALID,
        MapConversion: { ...VALID.MapConversion, XAxisAbscissa: 0.8660254, XAxisOrdinate: 0.5 },
        rotationDegrees: 30,
      });
      expect(result.state.MapConversion).toMatchObject({ XAxisAbscissa: 0.8660254, XAxisOrdinate: 0.5 });
    } finally { model.close(); }
  });

  it('requires replace for a georeferencing set earlier in the same session', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      model.bim.georef.set(VALID);
      const err = refusal(() => model.bim.georef.set(VALID));
      expect(err.code).toBe('ALREADY_GEOREFERENCED');
      model.bim.georef.set({ ...VALID, MapConversion: { ...VALID.MapConversion, Eastings: 2600001 }, replace: true });
      expect(model.bim.georef.get().MapConversion?.Eastings).toBe(2600001);
      // An update of a session-created georeferencing rewrites the creation.
      model.bim.georef.update({ MapConversion: { OrthogonalHeight: 401 } });
      const text = String(model.bim.export.ifc());
      expect(text.match(/=IFCMAPCONVERSION\(/g)?.length).toBe(1);
      expect(text).toMatch(/IFCMAPCONVERSION\(#5,#\d+,2600001\.,1200000\.,401\.,\$,\$,\$\);/);
    } finally { model.close(); }
  });

  it('refuses update and remove on a model that is not georeferenced', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      expect(refusedCleanly(model, () => model.bim.georef.update({ MapConversion: { Eastings: 1 } })).code).toBe('NOT_GEOREFERENCED');
      expect(refusedCleanly(model, () => model.bim.georef.remove()).code).toBe('NOT_GEOREFERENCED');
    } finally { model.close(); }
  });

  it('refuses an update with nothing in it, or with an attribute it does not know', async () => {
    const model = await open('IFC4', WITH_CONTEXT);
    try {
      model.bim.georef.set(VALID);
      expect(refusal(() => model.bim.georef.update({})).code).toBe('MISSING_INPUT');
      const typo = refusal(() => model.bim.georef.update({ MapConversion: { Easting: 5 } as never }));
      expect(typo.code).toBe('INVALID_INPUT');
      expect(typo.missing).toEqual(['MapConversion.Easting']);
    } finally { model.close(); }
  });

  it('refuses an IFC2X3 write when there are two IfcSites to choose from', async () => {
    const model = await open('IFC2X3', `${WITH_CONTEXT}
#7=IFCSITE('2Pbuu0tu59NfhrTsztVBK1',$,'Site 2',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`);
    try {
      expect(refusedCleanly(model, () => model.bim.georef.set(VALID)).code).toBe('AMBIGUOUS');
    } finally { model.close(); }
  });

  it('refuses an IFC2X3 write when there is no IfcSite', async () => {
    const model = await open('IFC2X3', NO_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set(VALID));
      expect(err.code).toBe('NO_ANCHOR');
      expect(err.missing).toEqual(['IfcSite']);
    } finally { model.close(); }
  });

  it.each(['IFC4X3_RC4', 'IFC4X3_RC1', 'IFC4'])('refuses FactorX/Y/Z on a %s file, whose schema does not declare IfcMapConversionScaled', async (fileSchema) => {
    const model = await open(fileSchema, WITH_CONTEXT);
    try {
      const err = refusedCleanly(model, () => model.bim.georef.set({
        ...VALID,
        MapConversion: { ...VALID.MapConversion, FactorX: 1, FactorY: 1, FactorZ: 1 },
      }));
      expect(err.code).toBe('UNSUPPORTED_SCHEMA');
      expect(err.message).toContain(fileSchema);
      expect(err.missing).toEqual(['MapConversion.FactorX', 'MapConversion.FactorY', 'MapConversion.FactorZ']);
    } finally { model.close(); }
  });

  it('accepts FactorX/Y/Z on an IFC4X3_ADD2 file', async () => {
    const model = await open('IFC4X3_ADD2', WITH_CONTEXT);
    try {
      model.bim.georef.set({ ...VALID, MapConversion: { ...VALID.MapConversion, FactorX: 1, FactorY: 1, FactorZ: 1 } });
      expect(String(model.bim.export.ifc())).toMatch(/=IFCMAPCONVERSIONSCALED\(/);
    } finally { model.close(); }
  });

  it('fails an export the exporter could only write without part of the georeferencing', async () => {
    // IFC4X3 -> IFC4: the target does not declare IfcMapConversionScaled, so
    // the exporter writes the conversion without its factors and warns. The
    // SDK must not hand that file back as if it carried the write.
    const model = await open('IFC4X3_ADD2', WITH_CONTEXT);
    try {
      model.bim.georef.set({ ...VALID, MapConversion: { ...VALID.MapConversion, FactorX: 0.9, FactorY: 0.9, FactorZ: 1 } });
      expect(() => model.bim.export.ifc(undefined, { schema: 'IFC4' })).toThrow(/georeferencing.*IfcMapConversionScaled/s);
      expect(String(model.bim.export.ifc())).toMatch(/=IFCMAPCONVERSIONSCALED\(/);
    } finally { model.close(); }
  });

  it('is not available on a backend without store access', async () => {
    const bim = new BimContext({ backend: {} as never });
    expect(() => bim.georef.get()).toThrow(/not available on this backend/);
  });
});
