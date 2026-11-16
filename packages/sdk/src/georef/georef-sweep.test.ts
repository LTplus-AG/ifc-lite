/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Sweeps. For every entity the georeferencing state is read from (the convention-set subgraph on IFC2X3; the
 * conversion, CRS, unit chain and context on IFC4), apply ONE generic edit to every attribute (by name and by
 * position, with several values), plus a deletion and a retype of the entity itself, and assert for each cell:
 * `get()` equals what re-parsing the export reads, or `get()` says it is untrusted and `update` refuses.
 * A class of staleness has no instance left when no cell fails.
 */

import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
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

type Fixture = { schema: string; data: string; entities: Array<{ id: number; attrs: string[] }> };

const CONVENTION: Fixture = {
  schema: 'IFC2X3',
  data: `${BASE}\n${sets(100, 1000000)}\n${attach(100, 6)}`,
  entities: [
    ...[100, 101, 102, 104, 105].map((id) => ({ id, attrs: ['Name', 'Description', 'NominalValue', 'Unit'] })),
    ...[103, 106].map((id) => ({ id, attrs: ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'HasProperties'] })),
    ...[107, 108].map((id) => ({ id, attrs: ['GlobalId', 'OwnerHistory', 'Name', 'Description', 'RelatedObjects', 'RelatingPropertyDefinition'] })),
    { id: 6, attrs: [] },
  ],
};
const ENTITY_PATH: Fixture = {
  schema: 'IFC4',
  data: `${BASE}
#80=IFCDIMENSIONALEXPONENTS(1,0,0,0,0,0,0);
#81=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#82=IFCMEASUREWITHUNIT(IFCLENGTHMEASURE(0.3048),#81);
#83=IFCCONVERSIONBASEDUNIT(#80,.LENGTHUNIT.,'FOOT',#82);
#20=IFCPROJECTEDCRS('EPSG:2229','d',$,$,$,$,#83);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`,
  entities: [
    { id: 21, attrs: ['SourceCRS', 'TargetCRS', 'Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale'] },
    { id: 20, attrs: ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone', 'MapUnit'] },
    { id: 83, attrs: ['Dimensions', 'UnitType', 'Name', 'ConversionFactor'] },
    { id: 82, attrs: ['ValueComponent', 'UnitComponent'] },
    { id: 81, attrs: ['Dimensions', 'UnitType', 'Prefix', 'Name'] },
    { id: 80, attrs: ['LengthExponent', 'MassExponent', 'TimeExponent', 'ElectricCurrentExponent', 'ThermodynamicTemperatureExponent', 'AmountOfSubstanceExponent', 'LuminousIntensityExponent'] },
    { id: 5, attrs: ['ContextIdentifier', 'ContextType', 'CoordinateSpaceDimension', 'Precision', 'WorldCoordinateSystem', 'TrueNorth'] },
  ],
};
const CONVENTION_IFC4: Fixture = { ...CONVENTION, schema: 'IFC4' };
const ENTITY_SCALED: Fixture = {
  schema: 'IFC4X3',
  data: `${BASE}
#95=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCPROJECTEDCRS('EPSG:2056','d',$,$,$,$,#95);
#21=IFCMAPCONVERSIONSCALED(#5,#20,1.,2.,3.,$,$,$,0.9,0.8,1.);`,
  entities: [
    { id: 21, attrs: ['SourceCRS', 'TargetCRS', 'Eastings', 'Northings', 'OrthogonalHeight', 'XAxisAbscissa', 'XAxisOrdinate', 'Scale', 'FactorX', 'FactorY', 'FactorZ'] },
    { id: 20, attrs: ['Name', 'Description', 'GeodeticDatum', 'VerticalDatum', 'MapProjection', 'MapZone', 'MapUnit'] },
    { id: 95, attrs: ['Dimensions', 'UnitType', 'Prefix', 'Name'] },
    { id: 5, attrs: ['ContextIdentifier', 'ContextType', 'CoordinateSpaceDimension', 'Precision', 'WorldCoordinateSystem', 'TrueNorth'] },
  ],
};
const NAMED = ['Zz', '12', '#6', '$', '', '0.5'];
const POSITIONAL: Array<string | number | null> = ['Zz', 12, null];

interface Cell { label: string; apply: (m: Awaited<ReturnType<typeof open>>) => void }
function cellsOf(f: Fixture): Cell[] {
  const cells: Cell[] = [];
  for (const { id, attrs } of f.entities) {
    attrs.forEach((name, index) => {
      for (const v of NAMED) cells.push({ label: `#${id}.${name} := ${JSON.stringify(v)}`, apply: (m) => m.bim.mutate.setAttribute({ modelId: 'model', expressId: id }, name, v) });
      for (const v of POSITIONAL) cells.push({ label: `#${id}[${index}] (${name}) := ${JSON.stringify(v)} by position`, apply: (m) => m.view().setPositionalAttribute(id, index, v as never) });
    });
    cells.push({ label: `#${id} deleted`, apply: (m) => { m.bim.store.removeEntity({ modelId: 'model', expressId: id }); } });
    cells.push({ label: `#${id} retyped to IfcWall`, apply: (m) => { m.view().setEntityType(id, 'IfcWall'); } });
  }
  return cells;
}

/** One cell: true when it held, or a description of how it did not. */
async function holds(f: Fixture, cell: Cell): Promise<true | string> {
  const m = await open(f.schema, f.data);
  try { cell.apply(m); } catch { return true; } // the generic API itself refused the edit: nothing to hold
  let state: GeoreferencingState;
  let file: GeoreferencingState;
  try { state = m.bim.georef.get(); file = await reparsed(m.bim); } catch (err) { return `get() or the export threw: ${(err as Error).message.slice(0, 120)}`; }
  if (!state.untrusted) {
    return isDeepStrictEqual(comparable(state), comparable(file)) ? true : `get() and the file disagree while get() calls itself trusted: ${JSON.stringify(comparable(state))} vs ${JSON.stringify(comparable(file))}`.slice(0, 400);
  }
  // An untrusted state is not a state to carry values from: update refuses, whatever the edit was.
  try { m.bim.georef.update({ MapConversion: { OrthogonalHeight: 9 } }); } catch (err) { if (err instanceof GeoreferencingError) return true; throw err; }
  return 'update succeeded on an untrusted state';
}

describe.each([
  ['the IFC2X3 convention-set subgraph', CONVENTION],
  ['the same subgraph in an IFC4 file (the reader\'s fallback)', CONVENTION_IFC4],
  ['the IFC4 conversion, CRS, unit chain and context', ENTITY_PATH],
  ['the IFC4X3 scaled conversion, CRS, unit and context', ENTITY_SCALED],
] as const)('sweep: %s', (_name, fixture) => {
  const cells = cellsOf(fixture);
  it(`${cells.length} generic edits: get() equals the re-parse or says it is untrusted`, async () => {
    const failures: string[] = [];
    for (const cell of cells) {
      const result = await holds(fixture, cell);
      if (result !== true) failures.push(`${cell.label}: ${result}`);
    }
    expect(failures).toEqual([]);
  }, 600000);
});

describe('sweep: the per-store index and the view answer correctly across a SEQUENCE of edits and reads', () => {
  const steps = (m: Awaited<ReturnType<typeof open>>): Array<[string, () => void]> => [
    ['rename the MapConversion set out', () => m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'Pset_Other')],
    ['rename it back', () => m.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'ePSet_MapConversion')],
    ['edit a property through the property API', () => m.view().setProperty(6, 'ePSet_MapConversion', 'Eastings', 5, 1 as never, undefined, false, 'IfcReal')],
    ['rename the CRS set to the other convention name', () => m.bim.mutate.setAttribute({ modelId: 'model', expressId: 106 }, 'Name', 'ePSet_MapConversion')],
    ['delete the Eastings atom', () => { m.bim.store.removeEntity({ modelId: 'model', expressId: 100 }); }],
    ['delete the MapConversion set', () => { m.bim.store.removeEntity({ modelId: 'model', expressId: 103 }); }],
  ];
  for (const schema of ['IFC2X3', 'IFC4']) {
    it(`${schema}: after each step get() equals the re-parse or says it is untrusted (one session, edits and reads alternating)`, async () => {
      const m = await open(schema, CONVENTION.data);
      const failures: string[] = [];
      const check = async (label: string) => {
        const state = m.bim.georef.get();
        if (state.untrusted) return;
        const file = await reparsed(m.bim);
        if (!isDeepStrictEqual(comparable(state), comparable(file))) failures.push(`${label}: ${JSON.stringify(comparable(state))} vs ${JSON.stringify(comparable(file))}`.slice(0, 300));
      };
      await check('initial');
      for (const [label, run] of steps(m)) {
        try { run(); } catch { continue; }
        await check(label);
        await check(`${label} (read again)`);
      }
      expect(failures).toEqual([]);
    });
  }
  it('two models in one process do not answer for each other', async () => {
    const a = await open('IFC2X3', CONVENTION.data);
    const b = await open('IFC2X3', CONVENTION.data);
    a.bim.mutate.setAttribute({ modelId: 'model', expressId: 103 }, 'Name', 'Pset_Other');
    expect(b.bim.georef.get().untrusted).toBeUndefined();
    expect(b.bim.georef.get().hasGeoreference).toBe(true);
    expect(a.bim.georef.get().hasGeoreference).toBe(false);
    b.bim.mutate.setAttribute({ modelId: 'model', expressId: 106 }, 'Name', 'Zz');
    expect(isDeepStrictEqual(comparable(a.bim.georef.get()), comparable(await reparsed(a.bim)))).toBe(true);
    expect(b.bim.georef.get().hasGeoreference).toBe(true);
  });
});
