/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Review round on the convention-set locator and the session's reads: one test per comment that reproduced. The
 * invariant throughout: `get()` is what re-parsing the export reads, or it says it is untrusted.
 */

import { describe, expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import { MutablePropertyView } from '@ifc-lite/mutations';
import { assessTrust } from './trust.js';
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


describe('locator: a set renamed from one convention name to the other', () => {
  it('ePSet_MapConversion becomes ePSet_ProjectedCRS: get() agrees with the file or says it is untrusted', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'ePSet_ProjectedCRS');
    await trueOrUntrusted(m.bim);
    expect(m.bim.georef.get().hasGeoreference).toBe(false);
  });
});

describe('locator: copies line up with the order the file lists them in, not by set id', () => {
  // The record of #200's pair precedes #100's in the file, and so do their relationships.
  const REVERSED = `${BASE}\n${sets(200, 2000000)}\n${attach(200, 6)}\n${sets(100, 1000000)}\n${attach(100, 6)}`;
  it('the reader takes the first set in the file; renaming it leaves the other as the one get() reports', async () => {
    const m = await open('IFC2X3', REVERSED);
    // The source lists #203 first, the export writes #103 first: the answer differs by file, so it is not trusted.
    expect(m.bim.georef.get().untrusted?.length).toBeGreaterThan(0);
    await trueOrUntrusted(m.bim);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 203 }, 'Name', 'Pset_Other');
    await trueOrUntrusted(m.bim);
    expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(1000000);
    // One copy left: the file and get() now agree on it.
    expect(m.bim.georef.get().MapConversion?.Eastings).toBe(1000000);
  });
});

describe('session: pending fields survive the deletion of the CRS the conversion references', () => {
  it('update Eastings, delete the source CRS: get() agrees with the file or says it is untrusted', async () => {
    const m = await open('IFC4', GEO);
    m.bim.georef.update({ MapConversion: { Eastings: 99 } });
    m.bim.store.removeEntity({ modelId: 'model', expressId: 20 });
    const state = m.bim.georef.get();
    const file = await reparsed(m.bim);
    // The invariant: get() is what the re-parse reads, or get() says it is untrusted. Neither half may be skipped.
    if (!state.untrusted?.length) {
      expect(state.MapConversion).toEqual(file.MapConversion);
      expect(file.MapConversion?.Eastings).toBe(99); // a re-parse that reads nothing would make the equality vacuous
    }
    else expect(state.untrusted.join(' ')).toMatch(/#20|CRS|deleted/i);
  });
});

describe('session: convention-set values are decoded the way the reader decodes them', () => {
  it('a text where a number belongs is untrusted, never a string in a numeric field', async () => {
    const m = await open('IFC2X3', BASE);
    m.bim.georef.set(SET);
    m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 'abc', PropertyValueType.Label, undefined, false, 'IfcLabel');
    const state = m.bim.georef.get();
    expect(typeof state.MapConversion?.Eastings === 'string').toBe(false);
    await trueOrUntrusted(m.bim);
  });
  it('a numeric string is read as the number the reader reads', async () => {
    const m = await open('IFC2X3', BASE);
    m.bim.georef.set(SET);
    m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', '2700000', PropertyValueType.Label, undefined, false, 'IfcLabel');
    await trueOrUntrusted(m.bim);
  });
});

describe('trust: an atom of a convention set renamed through the generic API', () => {
  it('the Eastings atom becomes `X`: get() agrees with the file or says it is untrusted, and update refuses', async () => {
    const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 100 }, 'Name', 'X');
    await trueOrUntrusted(m.bim);
    expect(m.bim.georef.get().untrusted?.length).toBeGreaterThan(0);
    refusal(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 1 } }));
  });
});

describe('input: a nested value that is not an object is refused, not dropped', () => {
  it.each([42, true, 'text', ['a']])('update with ProjectedCRS %j', async (value) => {
    const m = await open('IFC4', GEO);
    expect(refusal(() => m.bim.georef.update({ ProjectedCRS: value as never, MapConversion: { Eastings: 100 } })).code).toBe('INVALID_INPUT');
    expect(refusal(() => m.bim.georef.set({ ...SET, MapConversion: value as never, replace: true })).code).toBe('INVALID_INPUT');
  });
});

describe('text edits carry no marker characters (review finding on the in-band marker)', () => {
  it('an in-place Description of `CH1903+` is exactly that on the STEP line and after a re-parse', async () => {
    const m = await open('IFC4', GEO);
    m.bim.georef.update({ ProjectedCRS: { Description: 'CH1903+' } });
    expect(String(m.bim.export.ifc())).toMatch(/IFCPROJECTEDCRS\('EPSG:2056','CH1903\+',/);
    expect((await reparsed(m.bim)).ProjectedCRS?.Description).toBe('CH1903+');
    await trueOrUntrusted(m.bim);
  });
});

describe('trust assessments are never shared between models', () => {
  it('a model with a convention-set reason does not make a clean model in the same process untrusted', async () => {
    const REVERSED = `${BASE}\n${sets(200, 2000000)}\n${attach(200, 6)}\n${sets(100, 1000000)}\n${attach(100, 6)}`;
    const a = await open('IFC2X3', REVERSED);
    a.view(); // a session with a view and no pending change: the "nothing changed" assessment
    expect(a.bim.georef.get().untrusted?.length).toBeGreaterThan(0);
    const clean = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
    clean.view();
    expect(clean.bim.georef.get().untrusted).toBeUndefined();
    const plain = await open('IFC4', BASE);
    plain.view();
    expect(plain.bim.georef.get().untrusted).toBeUndefined();
  });
  it('the shared "nothing changed" assessment is frozen, so a write to it throws instead of leaking', async () => {
    const { store } = await parseModel(step('IFC4', BASE), { disableWorkerScan: true });
    const none = assessTrust(store, new MutablePropertyView(null, 'model'), null);
    expect(Object.isFrozen(none) && Object.isFrozen(none.reasons) && Object.isFrozen(none.foreign)).toBe(true);
    expect(() => { (none.reasons as Record<string, string[]>).ePSet = ['x']; }).toThrow(TypeError);
  });
});

describe('review: created and untrackable convention sets', () => {
  it('an unattached convention set created through the generic API is read from its created records', async () => {
    const m = await open('IFC2X3', BASE);
    const v = m.view();
    const atom = (name: string, value: number) => v.createEntity('IfcPropertySingleValue', [name, null, { typed: { type: 'IfcReal', value } }, null]).expressId;
    const ids = [atom('Eastings', 5), atom('Northings', 6), atom('OrthogonalHeight', 7)];
    v.createEntity('IfcPropertySet', ['3Zz9wAx1j4Bh3OB5NYQuhQ', null, 'ePSet_MapConversion', null, ids.map((i) => `#${i}`)]);
    await trueOrUntrusted(m.bim);
    const state = m.bim.georef.get();
    if (!state.untrusted) expect(state.MapConversion).toMatchObject({ Eastings: 5, Northings: 6, OrthogonalHeight: 7 });
  });
  it('two source sets that share a GlobalId cannot be told apart: a rename of one is untrusted, not a stale copy', async () => {
    const SAME = `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}\n${sets(200, 2000000).replace(/'0200aaaaaaaaaaaaaaaaaaa'/, "'0100aaaaaaaaaaaaaaaaaaa'")}\n${attach(200, 6)}`;
    const m = await open('IFC2X3', SAME);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'Pset_Other');
    await trueOrUntrusted(m.bim);
  });
  it('a source set with no GlobalId: a rename of it is untrusted, not a stale copy', async () => {
    const NOGID = `${BASE}\n${sets(100, 1000000).replace(/'0100aaaaaaaaaaaaaaaaaaa'/, '$')}\n${attach(100, 6)}`;
    const m = await open('IFC2X3', NOGID);
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'Pset_Other');
    await trueOrUntrusted(m.bim);
  });
});

describe('review: a deleted CRS keeps generic edits and pending fields together', () => {
  it('update Eastings, generic Northings, delete the CRS: get() has both, and the file agrees where it reads one', async () => {
    const m = await open('IFC4', GEO);
    m.bim.georef.update({ MapConversion: { Eastings: 99 } });
    m.bim.mutate.setAttribute({ modelId: 'model', expressId: 21 }, 'Northings', '77');
    m.bim.store.removeEntity({ modelId: 'model', expressId: 20 });
    const state = m.bim.georef.get();
    expect(state.MapConversion).toMatchObject({ Eastings: 99, Northings: 77 });
    const file = await reparsed(m.bim);
    if (file.MapConversion) expect(file.MapConversion).toMatchObject({ Eastings: 99, Northings: 77 });
  });
});

it('numeric convention-set CRS Name matches the exported reader and remains writable (#10382 review)', async () => {
  const m = await open('IFC2X3', `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`);
  m.bim.mutate.setProperty({ modelId: 'model', expressId: 6 }, 'ePSet_ProjectedCRS', 'Name', 2056);
  expect(m.bim.georef.get().ProjectedCRS?.Name).toBe('2056');
  expect(comparable(m.bim.georef.get())).toEqual(comparable(await reparsed(m.bim)));
  m.bim.georef.update({ MapConversion: { Eastings: 2700000 } });
  expect((await reparsed(m.bim)).MapConversion?.Eastings).toBe(2700000);
  expect(m.bim.georef.get().ProjectedCRS?.Name).toBe('2056');
});
