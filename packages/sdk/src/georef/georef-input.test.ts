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

describe('bim.georef IFC2X3 convention property sets', () => {
  // ePSet_MapConversion with the TargetCRS some tools add, naming the CRS.
  const IFC2X3_GEOREFERENCED = `${BASE}
#40=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2600000.),$);
#41=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(1200000.),$);
#42=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(400.),$);
#43=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:2056'),$);
#44=IFCPROPERTYSET('3Pbuu0tu59NfhrTsztVBK1',$,'ePSet_MapConversion',$,(#40,#41,#42,#43));
#45=IFCRELDEFINESBYPROPERTIES('4Pbuu0tu59NfhrTsztVBK1',$,$,$,(#6),#44);
#46=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
#47=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$);
#48=IFCPROPERTYSET('5Pbuu0tu59NfhrTsztVBK1',$,'ePSet_ProjectedCRS',$,(#46,#47));
#49=IFCRELDEFINESBYPROPERTIES('6Pbuu0tu59NfhrTsztVBK1',$,$,$,(#6),#48);`;

  it('renaming the CRS also renames ePSet_MapConversion.TargetCRS, so the two never disagree', async () => {
    const model = await open(IFC2X3_GEOREFERENCED, 'IFC2X3');
    try {
      model.bim.georef.update({ ProjectedCRS: { Name: 'EPSG:21781', MapUnit: 'METRE' } });
      const text = String(model.bim.export.ifc());
      expect(text).toMatch(/IFCPROPERTYSINGLEVALUE\('TargetCRS',\$,IFCLABEL\('EPSG:21781'\),\$\)/);
      expect(text).not.toContain("'EPSG:2056'");
    } finally { model.close(); }
  });

  it('writes ePSet_ProjectedCRS.Description as IfcText, as the convention types it', async () => {
    const model = await open(BASE, 'IFC2X3');
    try {
      model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', Description: 'CH1903+ / LV95', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
      });
      const text = String(model.bim.export.ifc());
      expect(text).toMatch(/IFCPROPERTYSINGLEVALUE\('Description',\$,IFCTEXT\('CH1903\+ \/ LV95'\),\$\)/);
      // The reader takes it back either way.
      const reopened = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
      try {
        expect(reopened.bim.georef.get().ProjectedCRS?.Description).toBe('CH1903+ / LV95');
      } finally { reopened.close(); }
    } finally { model.close(); }
  });
});

describe('bim.georef replace across several representation contexts', () => {
  it('says that the replacement is written for one context only', async () => {
    const model = await open(`${BASE.replace("(#5),#91", "(#5,#7),#91")}
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-5,#3,$);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#90);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);
#22=IFCMAPCONVERSION(#7,#20,1.,2.,3.,$,$,$);`);
    try {
      const result = model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
        replace: true,
      });
      expect(result.removed).toEqual(expect.arrayContaining(['IfcMapConversion #21', 'IfcMapConversion #22']));
      const note = result.notes.find((n) => n.includes('representation contexts'));
      expect(note).toMatch(/#5 'Model'.*#7 'Plan'/);
      expect(note).toMatch(/#7 'Plan'[^.]*no longer georeferenced/);
      const text = String(model.bim.export.ifc());
      expect(text.match(/=IFCMAPCONVERSION\(/g)).toHaveLength(1);
      expect(text).toMatch(/=IFCMAPCONVERSION\(#5,/);
    } finally { model.close(); }
  });
});

describe('bim.georef replace when only a non-preferred context carries the conversion', () => {
  it('names the context that loses its conversion', async () => {
    const model = await open(`${BASE.replace("(#5),#91", "(#5,#7),#91")}
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-5,#3,$);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#90);
#22=IFCMAPCONVERSION(#7,#20,1.,2.,3.,$,$,$);`);
    try {
      const result = model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
        replace: true,
      });
      expect(result.notes.find((n) => n.includes('representation context'))).toMatch(/#7 'Plan'[^.]*no longer georeferenced/);
    } finally { model.close(); }
  });
});

describe('bim.georef IFC2X3 review follow-ups', () => {
  const sets = (host: number, base: number, name: string) => `
#${base}=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(2600000.),$);
#${base + 1}=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(1200000.),$);
#${base + 2}=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(400.),$);
#${base + 3}=IFCPROPERTYSET('${base}buu0tu59NfhrTsztVBK1'.slice(0, 22),$,'ePSet_MapConversion',$,(#${base},#${base + 1},#${base + 2}));
#${base + 4}=IFCRELDEFINESBYPROPERTIES('${base}Pbuu0tu59NfhrTsztVBK'.slice(0, 22),$,$,$,(#${host}),#${base + 3});
#${base + 5}=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('${name}'),$);
#${base + 6}=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$);
#${base + 7}=IFCPROPERTYSET('${base}Qbuu0tu59NfhrTsztVBK'.slice(0, 22),$,'ePSet_ProjectedCRS',$,(#${base + 5},#${base + 6}));
#${base + 8}=IFCRELDEFINESBYPROPERTIES('${base}Rbuu0tu59NfhrTsztVBK'.slice(0, 22),$,$,$,(#${host}),#${base + 7});`;
  const fix = (s: string) => s.replace(/'(\d+[A-Za-z0-9_$]+)'\.slice\(0, 22\)/g, (_m, g: string) => `'${g.slice(0, 22)}'`);

  it('remove clears convention sets on IfcSite and IfcProject alike', async () => {
    const model = await open(fix(`${BASE}${sets(6, 40, 'EPSG:2056')}${sets(1, 60, 'EPSG:2056')}`), 'IFC2X3');
    try {
      const result = model.bim.georef.remove();
      expect(result.removed).toHaveLength(4);
      const reopened = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try {
        expect(reopened.bim.georef.get().hasGeoreference).toBe(false);
      } finally { reopened.close(); }
    } finally { model.close(); }
  });

  it('remove reports the IfcSite RefLatitude/RefLongitude fallback the file still carries', async () => {
    const withLatLong = BASE.replace(
      "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
      "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,0),(8,32,0),400.,$,$);",
    );
    const model = await open(fix(`${withLatLong}${sets(6, 40, 'EPSG:2056')}`), 'IFC2X3');
    try {
      model.bim.georef.remove();
      const reopened = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try {
        const fromFile = reopened.bim.georef.get();
        expect(fromFile.source).toBe('IfcSite');
        const pending = model.bim.georef.get();
        expect({ ...pending, pending: false }).toEqual(fromFile);
      } finally { reopened.close(); }
    } finally { model.close(); }
  });
});

describe('bim.georef second review follow-ups', () => {
  it('get() follows an ordinary property edit of an IFC2X3 convention set it wrote', async () => {
    const model = await open(BASE, 'IFC2X3');
    try {
      model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
      });
      model.bim.mutate.setProperty({ modelId: 'model', expressId: 6 }, 'ePSet_MapConversion', 'Eastings', 2600001, 'IfcLengthMeasure');
      const text = String(model.bim.export.ifc());
      const reopened = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
      try {
        expect(reopened.bim.georef.get().MapConversion?.Eastings).toBe(2600001);
        expect(model.bim.georef.get().MapConversion?.Eastings).toBe(2600001);
      } finally { reopened.close(); }
    } finally { model.close(); }
  });

  it('get() follows an ordinary property edit of a convention set the file already had, with no georef write', async () => {
    const author = await open(BASE, 'IFC2X3');
    let text: string;
    try {
      author.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
      });
      text = String(author.bim.export.ifc());
    } finally { author.close(); }
    const model = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
    try {
      const before = model.bim.georef.get();
      expect(before.source).toBe('ePSet_MapConversion');
      expect(before.MapConversion?.Eastings).toBe(2600000);
      model.bim.mutate.setProperty({ modelId: 'model', expressId: 6 }, 'ePSet_MapConversion', 'Eastings', 2600001, 'IfcLengthMeasure');
      const reopened = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try {
        expect(reopened.bim.georef.get().MapConversion?.Eastings).toBe(2600001);
        expect(model.bim.georef.get().MapConversion?.Eastings).toBe(2600001);
        expect(model.bim.georef.get().MapConversion?.Northings).toBe(1200000);
      } finally { reopened.close(); }
    } finally { model.close(); }
  });

  it('get() agrees with the export after the convention set entity is deleted through bim.store.removeEntity', async () => {
    const author = await open(BASE, 'IFC2X3');
    let text: string;
    try {
      author.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
      });
      text = String(author.bim.export.ifc());
    } finally { author.close(); }
    const model = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
    try {
      expect(model.bim.georef.get().MapConversion?.Eastings).toBe(2600000);
      const id = Number(/#(\d+)=IFCPROPERTYSET\([^\n]*'ePSet_MapConversion'/i.exec(text)?.[1]);
      expect(Number.isInteger(id)).toBe(true);
      // An earlier ordinary edit of the same set must not bring the deleted set back.
      model.bim.mutate.setProperty({ modelId: 'model', expressId: 6 }, 'ePSet_MapConversion', 'Eastings', 2600005, 'IfcLengthMeasure');
      expect(model.bim.georef.get().MapConversion?.Eastings).toBe(2600005);
      expect(model.bim.store.removeEntity({ modelId: 'model', expressId: id })).toBe(true);
      const exported = String(model.bim.export.ifc());
      expect(exported).not.toMatch(/ePSet_MapConversion/i);
      const reopened = await openModel(new TextEncoder().encode(exported), { disableWorkerScan: true });
      try {
        const fromFile = reopened.bim.georef.get();
        expect(fromFile.MapConversion).toBeNull();
        expect(model.bim.georef.get().MapConversion).toBeNull();
        expect({ ...model.bim.georef.get(), pending: false }).toEqual(fromFile);
      } finally { reopened.close(); }
    } finally { model.close(); }
  });

  it('get() follows an ordinary attribute edit of an existing IFC4 IfcMapConversion / IfcProjectedCRS', async () => {
    const author = await open(BASE);
    let text: string;
    try {
      author.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
      });
      text = String(author.bim.export.ifc());
    } finally { author.close(); }
    const model = await openModel(new TextEncoder().encode(text), { disableWorkerScan: true });
    try {
      const before = model.bim.georef.get();
      const mcId = before.MapConversion?.expressId as number;
      const crsId = before.ProjectedCRS?.expressId as number;
      model.bim.mutate.setAttribute({ modelId: 'model', expressId: mcId }, 'Northings', '1200005.5');
      model.bim.mutate.setAttribute({ modelId: 'model', expressId: crsId }, 'Description', 'CH1903+ / LV95');
      const reopened = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try {
        const fromFile = reopened.bim.georef.get();
        expect(fromFile.MapConversion?.Northings).toBe(1200005.5);
        const live = model.bim.georef.get();
        expect(live.MapConversion?.Northings).toBe(1200005.5);
        expect(live.ProjectedCRS?.Description).toBe(fromFile.ProjectedCRS?.Description);
        expect(live.ProjectedCRS?.Description).toBe('CH1903+ / LV95');
        expect(live.MapConversion?.Eastings).toBe(2600000);
      } finally { reopened.close(); }
      // A later georef write wins over an attribute edit of the same field, as at export.
      model.bim.georef.update({ MapConversion: { Northings: 1200010 } });
      expect(model.bim.georef.get().MapConversion?.Northings).toBe(1200010);
      model.bim.mutate.setAttribute({ modelId: 'model', expressId: mcId }, 'Eastings', '2600007');
      const again = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try {
        expect(again.bim.georef.get().MapConversion).toMatchObject({ Northings: 1200010, Eastings: 2600007 });
        expect(model.bim.georef.get().MapConversion).toMatchObject({ Northings: 1200010, Eastings: 2600007 });
      } finally { again.close(); }
    } finally { model.close(); }
  });

  it('a MapUnit re-pointed through the generic attribute API is not carried over from a stale read', async () => {
    const model = await open(withMapUnit('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'));
    try {
      expect(model.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'MILLIMETRE', mapUnitResolved: true });
      // The generic edit re-points the CRS at the plain METRE unit (#90); the export honours it.
      model.bim.mutate.setAttribute({ modelId: 'model', expressId: 20 }, 'MapUnit', '#90');
      const reopened = await openModel(new TextEncoder().encode(String(model.bim.export.ifc())), { disableWorkerScan: true });
      try { expect(reopened.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'METRE' }); } finally { reopened.close(); }
      // get() cannot resolve the new reference, so it says so instead of reporting the old unit as settled.
      expect(model.bim.georef.get().ProjectedCRS?.mapUnitResolved).toBe(false);
      // So a write that would carry the unit from the current state refuses; it never writes MILLIMETRE over METRE.
      expect(refusal(() => model.bim.georef.set(NEW_NO_UNIT)).missing).toEqual(['ProjectedCRS.MapUnit']);
      expect(refusal(() => model.bim.georef.update({ MapConversion: { OrthogonalHeight: 4 } })).code).toBe('UNSUPPORTED_RECORD');
      // An explicit unit still writes.
      expect(model.bim.georef.set({ ...NEW_NO_UNIT, ProjectedCRS: { Name: 'EPSG:2236', MapUnit: 'METRE' } }).mapUnit).toMatchObject({ value: 'METRE', source: 'explicit' });
    } finally { model.close(); }
  });

  it.each([1e308, -1e308, 361])('refuses rotationDegrees %s instead of writing a NaN axis', async (rotationDegrees) => {
    const model = await open(BASE);
    try {
      const err = refusal(() => model.bim.georef.set({
        ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
        MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
        rotationDegrees,
      }));
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.missing).toEqual(['rotationDegrees']);
    } finally { model.close(); }
  });
});
