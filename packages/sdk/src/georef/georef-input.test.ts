/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef` input rules that keep a value from being dropped or guessed:
 * a map unit is only carried from an existing CRS when the reader resolved
 * it (not when it fell back to METRE), and unknown keys are refused by every
 * write, `set` included.
 */

import { describe, expect, it } from 'vitest';
import { openModel, type HeadlessModelSession } from '../headless.js';
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

const BASE = `#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,(#5),#91);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);
#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#90=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#91=IFCUNITASSIGNMENT((#90));
#92=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#93=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#90);`;

/** An existing EPSG:2236 CRS whose MapUnit record is `unit`. */
const withMapUnit = (unit: string) => `${BASE}
#95=${unit};
#20=IFCPROJECTEDCRS('EPSG:2236',$,$,$,$,$,#95);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`;

const NEW_NO_UNIT = {
  ProjectedCRS: { Name: 'EPSG:2236' },
  MapConversion: { Eastings: 600000, Northings: 200000, OrthogonalHeight: 10 },
  replace: true,
} as GeoreferencingSetInput;

async function open(data: string, schema = 'IFC4'): Promise<HeadlessModelSession> {
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

describe('bim.georef map unit carried from an existing CRS', () => {
  it('reads an IfcConversionBasedUnitWithOffset foot as FOOT and carries it', async () => {
    const model = await open(withMapUnit("IFCCONVERSIONBASEDUNITWITHOFFSET(#92,.LENGTHUNIT.,'FOOT',#93,0.)"));
    try {
      expect(model.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'FOOT', mapUnitResolved: true });
      const result = model.bim.georef.set(NEW_NO_UNIT);
      expect(result.mapUnit).toMatchObject({ value: 'FOOT', source: 'existing' });
    } finally { model.close(); }
  });

  it('refuses to carry a unit the reader could not resolve, naming MapUnit', async () => {
    // IfcContextDependentUnit has no conversion factor: the reader reports
    // its METRE default, which must never be written as a fact.
    const model = await open(withMapUnit("IFCCONTEXTDEPENDENTUNIT(#92,.LENGTHUNIT.,'CHAIN')"));
    try {
      expect(model.bim.georef.get().ProjectedCRS).toMatchObject({ mapUnitResolved: false });
      const err = refusal(() => model.bim.georef.set(NEW_NO_UNIT));
      expect(err.code).toBe('MISSING_INPUT');
      expect(err.missing).toEqual(['ProjectedCRS.MapUnit']);
      expect(err.message).toContain('could not be resolved');
      expect(model.bim.georef.get().pending).toBe(false);
      // Given explicitly, the same write goes through.
      const ok = model.bim.georef.set({ ...NEW_NO_UNIT, ProjectedCRS: { Name: 'EPSG:2236', MapUnit: 'US SURVEY FOOT' } });
      expect(ok.mapUnit).toMatchObject({ value: 'US SURVEY FOOT', source: 'explicit' });
    } finally { model.close(); }
  });

  it('refuses an update that would report an unresolved unit as kept', async () => {
    const model = await open(withMapUnit("IFCCONTEXTDEPENDENTUNIT(#92,.LENGTHUNIT.,'CHAIN')"));
    try {
      const err = refusal(() => model.bim.georef.update({ MapConversion: { OrthogonalHeight: 11 } }));
      expect(err.code).toBe('MISSING_INPUT');
      expect(err.missing).toEqual(['ProjectedCRS.MapUnit']);
    } finally { model.close(); }
  });
});

describe('bim.georef unknown keys', () => {
  const VALID: GeoreferencingSetInput = {
    ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
    MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
  };
  it.each([
    ['MapConversion.Rotation', { ...VALID, MapConversion: { ...VALID.MapConversion, Rotation: 12 } }],
    ['MapConversion.scale', { ...VALID, MapConversion: { ...VALID.MapConversion, scale: 0.9996 } }],
    ['ProjectedCRS.Zone', { ...VALID, ProjectedCRS: { ...VALID.ProjectedCRS, Zone: '32N' } }],
    ['rotation', { ...VALID, rotation: 12 }],
  ])('set refuses %s instead of dropping it', async (path, input) => {
    const model = await open(BASE);
    try {
      const err = refusal(() => model.bim.georef.set(input as GeoreferencingSetInput));
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.missing).toEqual([path]);
      expect(model.bim.georef.get().pending).toBe(false);
    } finally { model.close(); }
  });

  it('update refuses an unknown top-level key too', async () => {
    const model = await open(BASE);
    try {
      model.bim.georef.set(VALID);
      const err = refusal(() => model.bim.georef.update({ MapConversion: { Eastings: 1 }, rotation: 5 } as never));
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.missing).toEqual(['rotation']);
    } finally { model.close(); }
  });
});
