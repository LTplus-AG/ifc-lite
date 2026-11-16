/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Generic mutations × georeferencing operations. Every cell is one of two
 * things: the state `get()` reports equals what re-parsing the export reads, or
 * `get()` says it is untrusted, an operation that would carry a value from it
 * refuses with a typed error, and a refusal leaves the export exactly as the
 * generic mutation alone produced it. There is no third state.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { PropertyValueType } from '@ifc-lite/data';
import type { MutablePropertyView } from '@ifc-lite/mutations';
import { HeadlessBackend } from '../headless.js';
import { BimContext } from '../context.js';
import { readGeoreferencing } from './read.js';
import { sourceOrderConflicts } from './epset-locator.js';
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

const SITE_PLAIN = "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);";
const SITE_LL = "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,0,0),(8,32,0,0),12.,$,$);";
const base = (site: string) => `#1=IFCPROJECT('0YvCT2_$X3_xJG3rzD8L_8',$,'P',$,$,$,$,(#5),#91);
#2=IFCCARTESIANPOINT((0.,0.,0.));
#3=IFCAXIS2PLACEMENT3D(#2,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);
${site}
#90=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#91=IFCUNITASSIGNMENT((#90));`;
const CRS_FIXTURE = `${base(SITE_LL)}
#95=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCPROJECTEDCRS('EPSG:2056','desc',$,$,$,$,#95);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`;

type Fixture = { schema: string; data: string; prep?: (bim: BimContext) => void };
const BUILDING = "#7=IFCBUILDING('1Pbuu0tu59NfhrTsztVBK2',$,'B',$,$,$,$,$,.ELEMENT.,$,$,$);";
const RIGID = `${base(SITE_PLAIN)}
#95=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#95);
#21=IFCRIGIDOPERATION(#5,#20,10.,20.,5.);`;
const EPSETS = `#30=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCREAL(2600000.),$);
#31=IFCPROPERTYSINGLEVALUE('Northings',$,IFCREAL(1200000.),$);
#32=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCREAL(400.),$);
#33=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaaa',$,'ePSet_MapConversion',$,(#30,#31,#32));
#34=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
#35=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('METRE'),$);
#36=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'ePSet_ProjectedCRS',$,(#34,#35));`;
const ATTACH = (host: number) => `#37=IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccc1',$,$,$,(#${host}),#33);
#38=IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccc2',$,$,$,(#${host}),#36);`;
const STOREY = "#8=IFCBUILDINGSTOREY('1Pbuu0tu59NfhrTsztVBK3',$,'L1',$,$,$,$,$,.ELEMENT.,0.);";
const FIXTURES: Record<string, Fixture> = {
  epset4: { schema: 'IFC4', data: `${base(SITE_PLAIN)}\n${EPSETS}\n${ATTACH(6)}` },
  strayset: { schema: 'IFC2X3', data: `${base(SITE_PLAIN)}\n${STOREY}\n${EPSETS}\n${ATTACH(8)}` },
  plain2x3: { schema: 'IFC2X3', data: `${base(SITE_PLAIN)}\n${BUILDING}` },
  plain4: { schema: 'IFC4', data: base(SITE_PLAIN) },
  rigid: { schema: 'IFC4X3_ADD2', data: RIGID },
  crs: { schema: 'IFC4', data: CRS_FIXTURE },
  site: { schema: 'IFC4', data: base(SITE_LL) },
  epset: {
    schema: 'IFC2X3',
    data: base(SITE_LL),
    prep: (bim) => { bim.georef.set({ ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 } }); },
  },
};

interface Ctx { bim: BimContext; view: () => MutablePropertyView }
type Expect = 'refuse' | 'any';
interface Row { name: string; fixture: keyof typeof FIXTURES; apply: (c: Ctx) => void; trusted: boolean; set: Expect; update: Expect; /** `set` with every value given, a unit included: refuses only when the model cannot anchor it. */ anchored?: 'refuse' }

const attr = (id: number, name: string, value: string) => (c: Ctx) => c.bim.mutate.setAttribute({ modelId: 'model', expressId: id }, name, value);
const positional = (id: number, index: number, value: string | number) => (c: Ctx) => { c.view().setPositionalAttribute(id, index, value as never); };

const ROWS: Row[] = [
  // Interpreted by the readers: get() reflects them.
  { name: 'named Northings of the conversion', fixture: 'crs', apply: attr(21, 'Northings', '77'), trusted: true, set: 'any', update: 'any' },
  { name: 'named Description of the CRS', fixture: 'crs', apply: attr(20, 'Description', 'other'), trusted: true, set: 'any', update: 'any' },
  { name: 'deleting the conversion', fixture: 'crs', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 21 }); }, trusted: true, set: 'any', update: 'any' },
  { name: 'deleting the CRS', fixture: 'crs', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 20 }); }, trusted: true, set: 'any', update: 'any' },
  { name: 'deleting the IfcSite fallback', fixture: 'site', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 6 }); }, trusted: true, set: 'any', update: 'any' },
  { name: 'property edit inside an IFC2X3 convention set', fixture: 'epset', apply: (c) => { c.view().setProperty(6, 'ePSet_MapConversion', 'Northings', 77, PropertyValueType.Real, undefined, false, 'IfcReal'); }, trusted: true, set: 'any', update: 'any' },
  { name: 'property edit in an unrelated IFC2X3 set', fixture: 'epset', apply: (c) => { c.view().setProperty(6, 'Pset_Other', 'X', 'y', PropertyValueType.Label, undefined, false, 'IfcLabel'); }, trusted: true, set: 'any', update: 'any' },
  // Not interpreted: get() says so and nothing carries from the stale value.
  { name: 'positional Name of the CRS', fixture: 'crs', apply: positional(20, 0, 'RENAMED'), trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'positional Eastings of the conversion', fixture: 'crs', apply: positional(21, 2, 99), trusted: false, set: 'any', update: 'refuse' },
  { name: 'named MapUnit re-pointed', fixture: 'crs', apply: attr(20, 'MapUnit', '#90'), trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'positional MapUnit re-pointed', fixture: 'crs', apply: positional(20, 6, '#90'), trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'TargetCRS of the conversion re-pointed', fixture: 'crs', apply: attr(21, 'TargetCRS', '#20'), trusted: false, set: 'any', update: 'refuse' },
  { name: 'the map unit record edited', fixture: 'crs', apply: attr(95, 'Prefix', '.KILO.'), trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'the map unit record deleted', fixture: 'crs', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 95 }); }, trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'a numeric attribute that does not parse', fixture: 'crs', apply: attr(21, 'Eastings', 'abc'), trusted: false, set: 'any', update: 'refuse' },
  { name: 'the conversion retyped', fixture: 'crs', apply: (c) => { c.view().setEntityType(21, 'IfcMapConversionScaled'); }, trusted: false, set: 'any', update: 'refuse' },
  { name: 'a second conversion created on the same context', fixture: 'crs', apply: (c) => { c.view().createEntity('IfcMapConversion', [5, 20, 9, 9, 9, null, null, null]); }, trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'positional RefLatitude of the IfcSite fallback', fixture: 'site', apply: positional(6, 9, 0), trusted: false, set: 'any', update: 'any' },
  // Audit rows: values and records the export would not write the way get() would state them.
  { name: 'an unset mandatory coordinate (blank Eastings)', fixture: 'crs', apply: attr(21, 'Eastings', '  '), trusted: false, set: 'any', update: 'refuse' },
  { name: 'a `$` Eastings (declined by the exporter)', fixture: 'crs', apply: attr(21, 'Eastings', '$'), trusted: false, set: 'any', update: 'refuse' },
  { name: 'an Infinity Eastings (declined by the exporter)', fixture: 'crs', apply: attr(21, 'Eastings', 'Infinity'), trusted: false, set: 'any', update: 'refuse' },
  { name: 'FactorX on a plain IfcMapConversion', fixture: 'crs', apply: attr(21, 'FactorX', '2'), trusted: false, set: 'any', update: 'refuse' },
  { name: 'a created point retyped to IfcMapConversion', fixture: 'crs', apply: (c) => { c.view().setEntityType(c.view().createEntity('IfcCartesianPoint', [[1, 2, 3]]).expressId, 'IfcMapConversion'); }, trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'a source point retyped to IfcMapConversion', fixture: 'crs', apply: (c) => { c.view().setEntityType(2, 'IfcMapConversion'); }, trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'a project unit edited (IFC4, no CRS yet)', fixture: 'plain4', apply: attr(90, 'Prefix', '.MILLI.'), trusted: true, set: 'any', update: 'any' },
  { name: 'a property edit inside a convention set (IFC4 file)', fixture: 'epset4', apply: (c) => { c.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 2700000, PropertyValueType.Real, undefined, false, 'IfcReal'); }, trusted: false, set: 'refuse', update: 'refuse' },
  { name: 'convention sets on an IfcBuildingStorey (IFC2X3)', fixture: 'strayset', apply: () => undefined, trusted: true, set: 'any', update: 'refuse' },
  // Facts the planners anchor on: created and deleted entities count.
  { name: 'a second IfcSite created (IFC2X3)', fixture: 'plain2x3', apply: (c) => { c.view().createEntity('IfcSite', ['2VQ9wAx1j4Bh3OB5NYQuhQ', null, 'Site2', ...Array(11).fill(null)]); }, trusted: true, set: 'refuse', update: 'any', anchored: 'refuse' },
  { name: 'the only IfcSite deleted (IFC2X3)', fixture: 'plain2x3', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 6 }); }, trusted: true, set: 'refuse', update: 'any', anchored: 'refuse' },
  { name: 'a second IfcProject created (IFC2X3)', fixture: 'plain2x3', apply: (c) => { c.view().createEntity('IfcProject', ['3VQ9wAx1j4Bh3OB5NYQuhQ', null, 'P2', ...Array(6).fill(null)]); }, trusted: true, set: 'any', update: 'any' },
  { name: 'an IfcBuilding retyped to IfcSite (IFC2X3)', fixture: 'plain2x3', apply: (c) => { c.view().setEntityType(7, 'IfcSite'); }, trusted: true, set: 'refuse', update: 'any', anchored: 'refuse' },
  { name: 'a second representation context created (IFC4)', fixture: 'plain4', apply: (c) => { c.view().createEntity('IfcGeometricRepresentationContext', [null, 'Model', 3, 1e-5, 3, null]); }, trusted: true, set: 'any', update: 'any' },
  { name: 'the only representation context deleted (IFC4)', fixture: 'plain4', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 5 }); }, trusted: true, set: 'refuse', update: 'any', anchored: 'refuse' },
  { name: 'the unit assignment deleted (IFC4)', fixture: 'plain4', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 91 }); }, trusted: true, set: 'any', update: 'any' },
  // IfcRigidOperation (IFC4X3).
  { name: 'a numeric attribute of the IfcRigidOperation edited by name', fixture: 'rigid', apply: attr(21, 'FirstCoordinate', '99'), trusted: false, set: 'any', update: 'any' },
  { name: 'the IfcRigidOperation deleted', fixture: 'rigid', apply: (c) => { c.bim.store.removeEntity({ modelId: 'model', expressId: 21 }); }, trusted: true, set: 'any', update: 'any' },
  { name: 'a positional edit of the IfcRigidOperation', fixture: 'rigid', apply: positional(21, 2, 99), trusted: false, set: 'any', update: 'any' },
];

async function fresh(fixture: Fixture, row: Row) {
  const { store } = await parseModel(step(fixture.schema, fixture.data), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'm.ifc', 'model');
  const bim = new BimContext({ backend });
  fixture.prep?.(bim);
  const ctx: Ctx = { bim, view: () => backend.ensureEditor().getMutationView() };
  row.apply(ctx);
  return { bim, ctx };
}

// GlobalIds the exporter generates for records it rewrites are random: compare everything else.
const dataOf = (bim: BimContext) => { const t = String(bim.export.ifc()); return t.slice(t.indexOf('DATA;')).replace(/'[0-9A-Za-z_$]{22}'/g, "'<GUID>'"); };
function comparable(state: GeoreferencingState) {
  const strip = <T extends object | null>(o: T) => { if (!o) return o; const { expressId: _e, ...rest } = o as Record<string, unknown>; return rest; };
  return { hasGeoreference: state.hasGeoreference, source: state.source, ProjectedCRS: strip(state.ProjectedCRS), MapConversion: strip(state.MapConversion), rotationDegrees: state.rotationDegrees };
}
async function reparsed(bim: BimContext): Promise<GeoreferencingState> {
  const { store } = await parseModel(new TextEncoder().encode(String(bim.export.ifc())), { disableWorkerScan: true });
  return readGeoreferencing(store);
}

const OPS = {
  setWithUnit: (bim: BimContext) => bim.georef.set({ ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' }, MapConversion: { Eastings: 5, Northings: 6, OrthogonalHeight: 7 }, replace: true }),
  set: (bim: BimContext) => bim.georef.set({ ProjectedCRS: { Name: 'EPSG:2056' }, MapConversion: { Eastings: 5, Northings: 6, OrthogonalHeight: 7 }, replace: true }),
  update: (bim: BimContext) => bim.georef.update({ MapConversion: { OrthogonalHeight: 9 } }),
  remove: (bim: BimContext) => bim.georef.remove(),
} as const;

describe.each(ROWS)('generic mutation: $name', (row) => {
  const fixture = FIXTURES[row.fixture];

  it('get() is true to the export, or says it is untrusted', async () => {
    const { bim } = await fresh(fixture, row);
    const state = bim.georef.get();
    if (row.trusted) {
      expect(state.untrusted).toBeUndefined();
      expect(comparable(state)).toEqual(comparable(await reparsed(bim)));
    } else {
      expect(state.untrusted?.length).toBeGreaterThan(0);
    }
  });

  for (const op of ['set', 'setWithUnit', 'update', 'remove'] as const) {
    it(`${op}: refuses with a typed error leaving the export alone, or the result is consistent`, async () => {
      const baseline = dataOf((await fresh(fixture, row)).bim);
      const { bim } = await fresh(fixture, row);
      let refused: unknown = null;
      try { OPS[op](bim); } catch (err) { refused = err; }
      if (refused) {
        expect(refused).toBeInstanceOf(GeoreferencingError);
        expect(dataOf(bim)).toBe(baseline);
      } else if (row.trusted) {
        expect(bim.georef.get().untrusted).toBeUndefined();
        expect(comparable(bim.georef.get())).toEqual(comparable(await reparsed(bim)));
      }
      if (op === 'setWithUnit' && row.anchored === 'refuse') expect(refused).toBeInstanceOf(GeoreferencingError);
      if ((op === 'set' || op === 'update') && row[op] === 'refuse') expect(refused).toBeInstanceOf(GeoreferencingError);
      if (!row.trusted && row.fixture === 'crs' && row.name.includes('second conversion')) expect(refused).toBeInstanceOf(GeoreferencingError);
    });
  }
});

describe('an IFC2X3 convention-set unit the file leaves unresolved stays unresolved after an ordinary property edit', () => {
  const sets = (unit: string) => `${base(SITE_PLAIN)}
#30=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCREAL(1.),$);
#31=IFCPROPERTYSINGLEVALUE('Northings',$,IFCREAL(2.),$);
#32=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCREAL(3.),$);
#33=IFCPROPERTYSET('0aaaaaaaaaaaaaaaaaaaaa',$,'ePSet_MapConversion',$,(#30,#31,#32));
#34=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:2056'),$);
#35=IFCPROPERTYSINGLEVALUE('MapUnit',$,IFCLABEL('${unit}'),$);
#36=IFCPROPERTYSET('0bbbbbbbbbbbbbbbbbbbbb',$,'ePSet_ProjectedCRS',$,(#34,#35));
#37=IFCRELDEFINESBYPROPERTIES('0cccccccccccccccccccccc',$,$,$,(#6),#33);
#38=IFCRELDEFINESBYPROPERTIES('0dddddddddddddddddddddd',$,$,$,(#6),#36);`.replace('0cccccccccccccccccccccc', '0ccccccccccccccccccccc').replace('0dddddddddddddddddddddd', '0ddddddddddddddddddddd');
  const open = async (unit: string) => {
    const { store } = await parseModel(step('IFC2X3', sets(unit)), { disableWorkerScan: true });
    const backend = new HeadlessBackend(store, 'm.ifc', 'model');
    return { bim: new BimContext({ backend }), view: () => backend.ensureEditor().getMutationView() };
  };
  const editEastings = (m: { view: () => MutablePropertyView }) => m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 5, PropertyValueType.Real, undefined, false, 'IfcReal');

  it('CHAIN: update refuses before and after the edit, and no unit is carried', async () => {
    const m = await open('CHAIN');
    expect(m.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'CHAIN', mapUnitResolved: false });
    expect(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 11 } })).toThrow(/MapUnit is required/);
    editEastings(m);
    expect(m.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'CHAIN', mapUnitResolved: false });
    expect(() => m.bim.georef.update({ MapConversion: { OrthogonalHeight: 11 } })).toThrow(/MapUnit is required/);
    expect(() => m.bim.georef.set({ ProjectedCRS: { Name: 'EPSG:2056' }, MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 }, replace: true })).toThrow(/MapUnit is required/);
  });

  it('a resolved unit stays resolved after the edit, and update still works', async () => {
    const m = await open('FOOT');
    editEastings(m);
    expect(m.bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'FOOT', mapUnitResolved: true });
    expect(m.bim.georef.update({ MapConversion: { OrthogonalHeight: 11 } }).state.MapConversion?.OrthogonalHeight).toBe(11);
  });
});

describe('a mutation kind nobody listed lands on the untrusted side', () => {
  it('an unrecognised change kind on a read entity marks it untrusted and blocks update', async () => {
    const row = ROWS[0];
    const { bim, ctx } = await fresh(FIXTURES.crs, row);
    expect(bim.georef.get().untrusted).toBeUndefined();
    const real = ctx.view().getEffectiveChanges();
    vi.spyOn(ctx.view(), 'getEffectiveChanges').mockReturnValue([...real, { entityId: 21, kind: 'a-kind-from-the-future' as never }]);
    expect(bim.georef.get().untrusted?.join(' ')).toMatch(/a-kind-from-the-future/);
    expect(() => bim.georef.update({ MapConversion: { OrthogonalHeight: 9 } })).toThrow(GeoreferencingError);
  });
});

describe('a fact the effective view cannot answer is unknown, and the write refuses naming it', () => {
  it('an IfcBuilding retyped to IfcSite: its attributes follow another layout', async () => {
    const row = ROWS.find((r) => r.name.startsWith('an IfcBuilding retyped'))!;
    const { bim } = await fresh(FIXTURES.plain2x3, row);
    let error: unknown;
    try { OPS.setWithUnit(bim); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(GeoreferencingError);
    expect((error as GeoreferencingError).code).toBe('UNSUPPORTED_RECORD');
    expect((error as GeoreferencingError).message).toMatch(/#7 \(IFCBUILDING\) was retyped/);
  });
});

it('native conversion trust ignores shadowed out-of-order convention sets before and after view creation (#10382 review)', async () => {
  const duplicate = "#133=IFCPROPERTYSET('0eeeeeeeeeeeeeeeeeeeee',$,'ePSet_MapConversion',$,(#30,#31,#32));";
  const data = `${CRS_FIXTURE}\n${duplicate}\n${EPSETS}\n${ATTACH(6)}`;
  const { store } = await parseModel(step('IFC4', data), { disableWorkerScan: true });
  expect(sourceOrderConflicts(store).length).toBeGreaterThan(0);
  const backend = new HeadlessBackend(store, 'm.ifc', 'model');
  const bim = new BimContext({ backend });
  expect(bim.georef.get().MapConversion?.Eastings).toBe(1);
  expect(bim.georef.get().untrusted).toBeUndefined();
  backend.ensureEditor();
  expect(bim.georef.get().untrusted).toBeUndefined();
});
