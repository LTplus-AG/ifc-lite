/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One test per finding of the adversarial audit of feat/georef-sdk-audit @ 8f3b5981. The class behind most
 * of them: the planner works on the session's effective view while the exporter re-derived decisions from
 * source bytes. Each test states the invariant that was broken: `get()` equals what re-parsing the export
 * reads, or it says it is untrusted, and an operation either refuses with a typed error or is consistent.
 */

import { describe, expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { HeadlessBackend } from '../headless.js';
import { BimContext } from '../context.js';
import { readGeoreferencing } from './read.js';
import { GeoreferencingError, type GeoreferencingState } from './types.js';

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
#91=IFCUNITASSIGNMENT((#90));`;
const GEO = `${BASE}
#95=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCPROJECTEDCRS('EPSG:2056','d',$,$,$,$,#95);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`;
const SET = { ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' }, MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 } };

async function open(schema: string, data: string) {
  const { store } = await parseModel(step(schema, data), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'm.ifc', 'model');
  const bim = new BimContext({ backend });
  return { bim, view: () => backend.ensureEditor().getMutationView() };
}

const strip = <T extends object | null>(o: T) => { if (!o) return o; const { expressId: _e, ...rest } = o as Record<string, unknown>; return rest; };
const comparable = (s: GeoreferencingState) => ({ hasGeoreference: s.hasGeoreference, source: s.source, ProjectedCRS: strip(s.ProjectedCRS), MapConversion: strip(s.MapConversion), rotationDegrees: s.rotationDegrees });
async function reparsed(bim: BimContext): Promise<GeoreferencingState> {
  const { store } = await parseModel(new TextEncoder().encode(String(bim.export.ifc())), { disableWorkerScan: true });
  return readGeoreferencing(store);
}
/** `get()` is what re-parsing the export reads, or it says it is not trustworthy. */
async function trueOrUntrusted(bim: BimContext): Promise<void> {
  const state = bim.georef.get();
  if (state.untrusted) return;
  expect(comparable(state)).toEqual(comparable(await reparsed(bim)));
}
const refusal = (fn: () => unknown): GeoreferencingError => {
  try { fn(); } catch (err) { if (err instanceof GeoreferencingError) return err; throw err; }
  throw new Error('expected a GeoreferencingError');
};
const sourceContextOf = (text: string) => Number(/IFCMAPCONVERSION\(#(\d+),/.exec(text)?.[1]);

describe('1. a map unit is never taken from an existing unit entity', () => {
  it('a project unit edited through the generic API does not become the CRS unit (named edit)', async () => {
    const m = await open('IFC4', BASE);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 90 }, 'Prefix', '.MILLI.');
    m.bim.georef.set(SET);
    expect((await reparsed(m.bim)).ProjectedCRS?.MapUnit).toBe('METRE');
    await trueOrUntrusted(m.bim);
  });
  it('same by position', async () => {
    const m = await open('IFC4', BASE);
    m.view().setPositionalAttribute(90, 2, '.KILO.' as never);
    m.bim.georef.set(SET);
    expect((await reparsed(m.bim)).ProjectedCRS?.MapUnit).toBe('METRE');
  });
});

const EPSETS = `#30=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCREAL(2600000.),$);
#31=IFCPROPERTYSINGLEVALUE('Northings',$,IFCREAL(1200000.),$);
#32=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCREAL(400.),$);
#33=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaaa',$,'ePSet_MapConversion',$,(#30,#31,#32));
#34=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
#35=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$);
#36=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'ePSet_ProjectedCRS',$,(#34,#35));`;
const attach = (host: number) => `#37=IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccc1',$,$,$,(#${host}),#33);
#38=IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccc2',$,$,$,(#${host}),#36);`;

describe('2. convention sets in an IFC4 / IFC4X3 file are read, edited and replaced like in IFC2X3', () => {
  const setup = async (schema = 'IFC4') => {
    const m = await open(schema, `${BASE}\n${EPSETS}\n${attach(6)}`);
    m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 2700000, PropertyValueType.Real, undefined, false, 'IfcReal');
    return m;
  };
  it.each(['IFC4', 'IFC4X3'])('%s: an edited set is not reported as current, and update refuses instead of writing a mixed file', async (schema) => {
    const m = await setup(schema);
    expect(m.bim.georef.get().untrusted?.length).toBeGreaterThan(0);
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 401 } }));
  });
  it('set without replace refuses while the sets exist; with replace they are deleted', async () => {
    const m = await setup();
    expect(refusal(() => m.bim.georef.set(SET)).code).toBe('ALREADY_GEOREFERENCED');
    m.bim.georef.set({ ...SET, replace: true });
    const after = await reparsed(m.bim);
    expect(after.MapConversion?.Eastings).toBe(2600000);
    expect(after.source).toBe('IfcMapConversion');
    await trueOrUntrusted(m.bim);
  });
  it('remove removes them: get() and the re-parse agree that nothing is georeferenced', async () => {
    const m = await setup();
    m.bim.georef.remove();
    expect((await reparsed(m.bim)).hasGeoreference).toBe(false);
    await trueOrUntrusted(m.bim);
  });
});

describe('3. convention sets the writer does not manage are still copies the reader takes', () => {
  const STOREY = "#8=IFCBUILDINGSTOREY('1Pbuu0tu59NfhrTsztVBK3',$,'L1',$,$,$,$,$,.ELEMENT.,0.);";
  it.each([
    ['on another host', `${BASE}\n${STOREY}\n${EPSETS}\n${attach(8)}`],
    ['unattached', `${BASE}\n${EPSETS}`],
  ])('IFC2X3 sets %s: get() is what the reader reads; set without replace and update refuse, set replace and remove clear them', async (_n, data) => {
    const m = await open('IFC2X3', data);
    await trueOrUntrusted(m.bim);
    refusal(() => m.bim.georef.set(SET));
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 1 } }));
    m.bim.georef.set({ ...SET, replace: true });
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2600000);
    const r = await open('IFC2X3', data);
    r.bim.georef.remove();
    expect((await reparsed(r.bim)).hasGeoreference).toBe(false);
  });
});

describe('4. a conversion-based unit whose factor disagrees with its name is never carried', () => {
  const FOOT = `${BASE}
#80=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#82=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048006096),#81);
#83=IFCCONVERSIONBASEDUNIT(#80,.LENGTHUNIT.,'FOOT',#82);
#20=IFCPROJECTEDCRS('EPSG:2229',$,$,$,$,$,#83);
#21=IFCMAPCONVERSION(#5,#20,6500000.,1800000.,0.,$,$,$);`;
  it('the unit is unresolved and set without a unit refuses', async () => {
    const m = await open('IFC4', FOOT);
    expect(m.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'FOOT', mapUnitResolved: false });
    expect(refusal(() => m.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:2229' }, MapConversion: { Eastings: 6500000, Northings: 1800000, OrthogonalHeight: 0 }, replace: true })).missing).toEqual(['ProjectedCRS.MapUnit']);
  });
});

describe('5. the SourceCRS is the one the planner chose', () => {
  const TWO = `${BASE.replace("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);", "#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',3,1.E-5,#3,$);\n#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);")}`;
  it('(a) contexts whose ContextType was swapped through the generic API', async () => {
    const m = await open('IFC4', TWO);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 5 }, 'ContextType', 'Model');
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 7 }, 'ContextType', 'Plan');
    m.bim.georef.set(SET);
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(5);
  });
  it('(b) a created 3D Model context beats a source 2D one', async () => {
    const m = await open('IFC4', BASE.replace("'Model',3,", "'Plan',2,"));
    const created = m.view().createEntity('IfcGeometricRepresentationContext', [null, 'Model', 3, 1e-5, 3, null]);
    m.bim.georef.set(SET);
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(created.expressId);
  });
  it('(c) the only context deleted and a new one created: the write succeeds and the export is written', async () => {
    const m = await open('IFC4', BASE);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 5 });
    const created = m.view().createEntity('IfcGeometricRepresentationContext', [null, 'Model', 3, 1e-5, 3, null]);
    m.bim.georef.set(SET);
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(created.expressId);
  });
});

describe('6. a mandatory coordinate the export would not write verbatim', () => {
  it.each(['  ', '$', 'Infinity', '1e999'])('Eastings %j through the generic API: untrusted or true, and update refuses', async (value) => {
    const m = await open('IFC4', GEO);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 21 }, 'Eastings', value);
    await trueOrUntrusted(m.bim);
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 5 } }));
  });
});

describe('7. a retype into a georeferencing class', () => {
  it.each(['created point', 'source point below the conversion'])('%s: untrusted, and no write goes on top of it', async (which) => {
    const m = await open('IFC4', GEO);
    const id = which === 'created point' ? m.view().createEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId : 2;
    m.view().setEntityType(id, 'IfcMapConversion');
    expect(m.bim.georef.get().untrusted?.length).toBeGreaterThan(0);
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 5 } }));
    refusal(() => m.bim.georef.set({ ...SET, replace: true }));
  });
});

describe('8. an attribute the record does not have', () => {
  it('FactorX on a plain IfcMapConversion is untrusted and never shown', async () => {
    const m = await open('IFC4', GEO);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 21 }, 'FactorX', '2');
    const state = m.bim.georef.get();
    expect(state.untrusted?.join(' ')).toMatch(/FactorX/);
    expect(state.MapConversion?.type).toBe('IfcMapConversion');
    expect((state.MapConversion as unknown as Record<string, unknown>).FactorX).toBeUndefined();
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 5 } }));
  });
});

describe('9. CRS text is written as text', () => {
  it('`$` and `*` stay text on an in-place update, and get() equals the re-parse', async () => {
    const m = await open('IFC4', GEO);
    m.bim.georef.update({ ProjectedCRS: { GeodeticDatum: '$', MapProjection: '*', VerticalDatum: '#12', MapZone: '.X.' } });
    const text = String(m.bim.export.ifc());
    expect(text).toMatch(/IFCPROJECTEDCRS\('EPSG:2056','d','\$','#12','\*','\.X\.',#\d+\)/);
    const file = await reparsed(m.bim);
    expect(file.ProjectedCRS).toMatchObject({ GeodeticDatum: '$', MapProjection: '*', VerticalDatum: '#12', MapZone: '.X.' });
    await trueOrUntrusted(m.bim);
  });
  it('an empty text is refused at the API, never written as an empty or a null slot', async () => {
    const m = await open('IFC4', GEO);
    expect(refusal(() => m.bim.georef.update({ ProjectedCRS: { Description: '' } })).code).toBe('INVALID_INPUT');
    await trueOrUntrusted(m.bim);
  });
});
