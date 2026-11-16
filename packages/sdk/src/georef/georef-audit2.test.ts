/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The second adversarial audit (feat/georef-sdk-audit @ bd3f6412), F1-F8, one test per repro. The invariant
 * throughout: `get()` is what re-parsing the export reads, or it says it is untrusted; an operation either
 * refuses with a typed error that names what to do next, or its result is in the file.
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
const STOREY = "#8=IFCBUILDINGSTOREY('1Pbuu0tu59NfhrTsztVBK3',$,'L1',$,$,$,$,$,.ELEMENT.,0.);";
const SET = { ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' }, MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 } };

/** A convention-set pair: MapConversion set #b+3, ProjectedCRS set #b+6. */
const sets = (b: number, eastings: number) => `#${b}=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCREAL(${eastings}.),$);
#${b + 1}=IFCPROPERTYSINGLEVALUE('Northings',$,IFCREAL(1200000.),$);
#${b + 2}=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCREAL(400.),$);
#${b + 3}=IFCPROPERTYSET('0${String(b).padStart(2, '0')}aaaaaaaaaaaaaaaaaaa',$,'ePSet_MapConversion',$,(#${b},#${b + 1},#${b + 2}));
#${b + 4}=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
#${b + 5}=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$);
#${b + 6}=IFCPROPERTYSET('0${String(b).padStart(2, '0')}bbbbbbbbbbbbbbbbbbb',$,'ePSet_ProjectedCRS',$,(#${b + 4},#${b + 5}));`;
const attach = (b: number, host: number) => `#${b + 7}=IFCRELDEFINESBYPROPERTIES('0${String(b).padStart(2, '0')}cccccccccccccccccc1',$,$,$,(#${host}),#${b + 3});
#${b + 8}=IFCRELDEFINESBYPROPERTIES('0${String(b).padStart(2, '0')}cccccccccccccccccc2',$,$,$,(#${host}),#${b + 6});`;

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
const conventionSetCount = (text: string) => (text.match(/IFCPROPERTYSET\([^;]*'ePSet_MapConversion'/gi) ?? []).length;

describe('F1. a convention set created through the property API is a copy like any other (IFC2X3)', () => {
  it('on another host: set refuses naming it; replace removes it and the file reads the new position', async () => {
    const m = await open('IFC2X3', `${BASE}\n${STOREY}`);
    for (const [p, v] of [['Eastings', 5], ['Northings', 6], ['OrthogonalHeight', 7]] as const) {
      m.bim.mutate.setProperty({ modelId: 'model', expressId: 8 }, 'ePSet_MapConversion', p, v);
    }
    await trueOrUntrusted(m.bim);
    const err = refusal(() => m.bim.georef.set(SET));
    expect(err.code).toBe('ALREADY_GEOREFERENCED');
    expect(err.message).toMatch(/#8/);
    m.bim.georef.set({ ...SET, replace: true });
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2600000);
    await trueOrUntrusted(m.bim);
  });
});

describe('F2. a unit is resolved only when its declared factor is the one the writer would emit', () => {
  const unit = (name: string, factor: string) => `${BASE}
#80=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#82=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(${factor}),#81);
#83=IFCCONVERSIONBASEDUNIT(#80,.LENGTHUNIT.,'${name}',#82);
#20=IFCPROJECTEDCRS('EPSG:2229',$,$,$,$,$,#83);
#21=IFCMAPCONVERSION(#5,#20,6500000.,1800000.,0.,$,$,$);`;
  const NEW_NO_UNIT = { ProjectedCRS: { Name: 'EPSG:2229' }, MapConversion: { Eastings: 6500000, Northings: 1800000, OrthogonalHeight: 0 }, replace: true };
  it.each([
    ['US SURVEY FOOT', '0.3048'], ['METRE', '0.3048'], ['FOOT', '0.'], ['FOOT', '-0.3048'], ['FOOT', '$'], ['FOOT', '0.3048006096'],
  ])('%s declared as %s is unresolved, so set without a unit refuses', async (name, factor) => {
    const m = await open('IFC4', unit(name, factor));
    expect(m.bim.georef.get().ProjectedCRS?.mapUnitResolved).toBe(false);
    expect(refusal(() => m.bim.georef.set(NEW_NO_UNIT)).missing).toEqual(['ProjectedCRS.MapUnit']);
  });
  it.each([['FOOT', '0.3048'], ['US SURVEY FOOT', '0.3048006096012192'], ['US SURVEY FOOT', '0.30480060960122']])('%s declared as %s stays resolved', async (name, factor) => {
    const m = await open('IFC4', unit(name, factor));
    expect(m.bim.georef.get().ProjectedCRS?.mapUnitResolved).toBe(true);
  });
});

describe('F3. replacing a convention set that exists twice on one host', () => {
  it('both copies go, one fresh pair is written, and the result is in the file', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}\n${sets(200, 2000000)}\n${attach(200, 6)}`);
    m.bim.georef.set({ ...SET, replace: true });
    const text = String(m.bim.export.ifc());
    expect(conventionSetCount(text)).toBe(1);
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2600000);
    await trueOrUntrusted(m.bim);
  });
});

describe('F4. which copy the reader takes', () => {
  it('copies on the site and the project, the first one edited: get() agrees or says it cannot', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}\n${sets(200, 2000000)}\n${attach(200, 1)}`);
    await trueOrUntrusted(m.bim);
    m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 1500000, PropertyValueType.Real, undefined, false, 'IfcReal');
    await trueOrUntrusted(m.bim);
  });
});

describe('F5. an IFC4 file that only has convention sets', () => {
  it('a set created through the property API: get() agrees or says it is untrusted', async () => {
    const m = await open('IFC4', BASE);
    for (const [p, v] of [['Eastings', 5], ['Northings', 6], ['OrthogonalHeight', 7]] as const) {
      m.view().setProperty(6, 'ePSet_MapConversion', p, v, PropertyValueType.Real, undefined, false, 'IfcReal');
    }
    await trueOrUntrusted(m.bim);
  });
});

describe('F6. CRS text edited through the generic API', () => {
  it.each(['$', '', '*', '#12'])('Description %j: get() agrees with the file or says it is untrusted', async (value) => {
    const m = await open('IFC4', GEO);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 20 }, 'Description', value);
    await trueOrUntrusted(m.bim);
  });
  it.each(['\u0000#5', '^', '^@', '\\^@', '\u0000'])('text %j is text on both paths: nothing is read as a marker', async (value) => {
    const m = await open('IFC4', GEO);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 20 }, 'Description', value);
    await trueOrUntrusted(m.bim);
    const n = await open('IFC4', GEO);
    n.bim.georef.update({ ProjectedCRS: { Description: value === '\u0000' ? 'x\u0000' : value } });
    await trueOrUntrusted(n.bim);
    expect((await reparsed(n.bim)).ProjectedCRS?.Description).toBe(value === '\u0000' ? 'x\u0000' : value);
  });
});

describe('F7. a deleted or retyped SourceCRS is replaced by the planner\'s next choice', () => {
  const TWO = BASE.replace("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);", "#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);\n#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);");
  it('the chosen context deleted after the write', async () => {
    const m = await open('IFC4', TWO);
    m.bim.georef.set(SET);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 5 });
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(7);
  });
  it('the chosen context retyped after the write', async () => {
    const m = await open('IFC4', TWO);
    m.bim.georef.set(SET);
    m.view().setEntityType(5, 'IfcSite');
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(7);
  });
  const MIXED = BASE.replace("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#3,$);", '').replace("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);", "#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);\n#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Plan',2,1.E-5,#3,$);\n#8=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Detail',3,1.E-5,#3,$);");
  it('the fallback is what a fresh plan would pick among the survivors: another 3D context before a 2D one', async () => {
    const m = await open('IFC4', MIXED);
    m.bim.georef.set(SET);
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(5);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 5 });
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(8);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 8 });
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(7);
  });
  it('a Model 3D context later in the file beats an earlier non-Model one after the first choice goes', async () => {
    const m = await open('IFC4', MIXED.replace("'Detail',3", "'Model',3"));
    m.bim.georef.set(SET);
    m.view().setEntityType(5, 'IfcSite');
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(8);
  });
  it('a sub-context is never the SourceCRS, and losing its parent is the typed refusal, not the sub-context', async () => {
    const m = await open('IFC4', `${BASE}\n#9=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);`);
    m.bim.georef.set(SET);
    expect(sourceContextOf(String(m.bim.export.ifc()))).toBe(5);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 5 });
    expect(() => m.bim.export.ifc()).toThrow(/IfcGeometricRepresentationContext/);
  });
  it('no context left: the typed refusal stays', async () => {
    const m = await open('IFC4', BASE);
    m.bim.georef.set(SET);
    m.bim.store.removeEntity({ modelId: 'model', expressId: 5 });
    expect(() => m.bim.export.ifc()).toThrow(/IfcGeometricRepresentationContext/);
  });
});

describe('F8. stray convention sets never leave a user without a next step', () => {
  const STRAYS = [
    ['on a storey', `${STOREY}\n${sets(100, 1)}\n${attach(100, 8)}`],
    ['unattached', sets(100, 1)],
  ] as const;
  describe.each(STRAYS)('IFC4 with an IfcMapConversion and sets %s', (_n, extra) => {
    const data = `${GEO}\n${extra}`;
    it('update works (the conversion governs), set replace works, remove works and leaves nothing georeferenced', async () => {
      const a = await open('IFC4', data);
      a.bim.georef.update({ MapConversion: { OrthogonalHeight: 9 } });
      expect((await reparsed(a.bim)).MapConversion?.OrthogonalHeight).toBe(9);
      const b = await open('IFC4', data);
      b.bim.georef.set({ ...SET, replace: true });
      expect((await reparsed(b.bim)).MapConversion?.Eastings).toBe(2600000);
      const c = await open('IFC4', data);
      const removed = c.bim.georef.remove();
      expect(removed.removed.join(' ')).toMatch(/ePSet_/);
      expect((await reparsed(c.bim)).hasGeoreference).toBe(false);
    });
  });
  describe.each(STRAYS)('IFC2X3 with sets %s', (_n, extra) => {
    const data = `${BASE}\n${STOREY}\n${extra}`;
    it('set without replace and update refuse naming the sets and "replace"; set replace and remove delete them', async () => {
      const a = await open('IFC2X3', data);
      expect(refusal(() => a.bim.georef.set(SET)).message).toMatch(/ePSet_MapConversion/);
      expect(refusal(() => a.bim.georef.update({ MapConversion: { OrthogonalHeight: 9 } })).message).toMatch(/replace/);
      a.bim.georef.set({ ...SET, replace: true });
      expect((await reparsed(a.bim)).MapConversion?.Eastings).toBe(2600000);
      await trueOrUntrusted(a.bim);
      const b = await open('IFC2X3', data);
      b.bim.georef.remove();
      expect((await reparsed(b.bim)).hasGeoreference).toBe(false);
    });
  });
});

describe('review follow-ups that are small and real', () => {
  it('a null factor is refused, not replaced by the existing one (IFC4X3)', async () => {
    const m = await open('IFC4X3', `${BASE}
#95=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCPROJECTEDCRS('EPSG:2056','d',$,$,$,$,#95);
#21=IFCMAPCONVERSIONSCALED(#5,#20,1.,2.,3.,$,$,$,0.9,0.8,1.);`);
    refusal(() => m.bim.georef.update({ MapConversion: { FactorX: null as never } }));
  });
  it('sets recreated through the property API after an empty remove() are read back (IFC2X3)', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    m.bim.georef.remove();
    expect(m.bim.georef.get().hasGeoreference).toBe(false);
    for (const [p, v] of [['Eastings', 5], ['Northings', 6], ['OrthogonalHeight', 7]] as const) {
      m.view().setProperty(6, 'ePSet_MapConversion', p, v, PropertyValueType.Real, undefined, false, 'IfcReal');
    }
    await trueOrUntrusted(m.bim);
  });
  it('the state a write returns is a snapshot: changing it does not change later get()', async () => {
    const m = await open('IFC4', BASE);
    const result = m.bim.georef.set(SET);
    (result.state.MapConversion as unknown as { Eastings: number }).Eastings = 99;
    expect(m.bim.georef.get().MapConversion?.Eastings).toBe(2600000);
  });
});

describe('the convention name is written as the convention spells it', () => {
  it('a replace over two copies on the anchor writes `ePSet_` (exact), never a variant a strict reader would miss', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}\n${sets(200, 2000000)}\n${attach(200, 6)}`);
    m.bim.georef.set({ ...SET, replace: true });
    const text = String(m.bim.export.ifc());
    expect(text).toMatch(/IFCPROPERTYSET\([^;]*'ePSet_MapConversion'/);
    expect(text).toMatch(/IFCPROPERTYSET\([^;]*'ePSet_ProjectedCRS'/);
    expect(text).not.toMatch(/'ePset_/);
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2600000);
  });
  it('a second replace keeps the exact spelling too', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}\n${sets(200, 2000000)}\n${attach(200, 6)}`);
    m.bim.georef.set({ ...SET, replace: true });
    m.bim.georef.set({ ...SET, MapConversion: { ...SET.MapConversion, Eastings: 2700000 }, replace: true });
    const text = String(m.bim.export.ifc());
    expect(text).not.toMatch(/'ePset_/);
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2700000);
  });
});

describe('a set\'s name is its record\'s: renames through the generic API', () => {
  const OTHER = (b: number) => sets(b, 5).replace("'ePSet_MapConversion'", "'Pset_Other'").replace("'ePSet_ProjectedCRS'", "'Pset_Other2'");
  it('a convention set renamed out: the copy is gone, get() agrees and update has nothing to edit', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'Pset_Other');
    await trueOrUntrusted(m.bim);
    expect(m.bim.georef.get().untrusted).toBeUndefined();
    expect(refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 1 } })).code).toBe('NOT_GEOREFERENCED');
  });
  it('an unrelated set renamed into ePSet_MapConversion by name: the copy is there, get() agrees', async () => {
    const m = await open('IFC2X3', `${BASE}\n${OTHER(200)}\n${attach(200, 6)}`);
    expect(m.bim.georef.get().hasGeoreference).toBe(false);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 203 }, 'Name', 'ePSet_MapConversion');
    await trueOrUntrusted(m.bim);
    expect((await reparsed(m.bim)).hasGeoreference).toBe(true);
    expect(refusal(() => m.bim.georef.set(SET)).code).toBe('ALREADY_GEOREFERENCED');
  });
  it('the same by position', async () => {
    const m = await open('IFC2X3', `${BASE}\n${OTHER(200)}\n${attach(200, 6)}`);
    m.view().setPositionalAttribute(203, 2, 'ePSet_MapConversion' as never);
    await trueOrUntrusted(m.bim);
    expect(refusal(() => m.bim.georef.set(SET)).code).toBe('ALREADY_GEOREFERENCED');
  });
  it('sets created on another host after an empty remove() are read back', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    m.bim.georef.remove();
    for (const [p, v] of [['Eastings', 5], ['Northings', 6], ['OrthogonalHeight', 7]] as const) {
      m.view().setProperty(1, 'ePSet_MapConversion', p, v, PropertyValueType.Real, undefined, false, 'IfcReal');
    }
    await trueOrUntrusted(m.bim);
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(5);
  });
});
