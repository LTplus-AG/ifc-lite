/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bim.georef.setSite`: IfcSite RefLatitude/RefLongitude/RefElevation are
 * written as the schema's IfcCompoundPlaneAngleMeasure (every WHERE rule of
 * IFC2X3 and IFC4/IFC4X3 holds), read back by the parser's reader to the
 * millionth of a second, refused cleanly, and undone in one step.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractGeoreferencingOnDemand, parseModel } from '@ifc-lite/parser';
import { undoRecordedMutationOperations, type MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { HeadlessBackend } from '../headless.js';
import { BimContext } from '../context.js';
import { fromCompoundPlaneAngle, toCompoundPlaneAngle } from './site-angle.js';
import { GeoreferencingError } from './types.js';

// The refusal assertions compare the whole STEP file, including its clock-based FILE_NAME.
const exportClock = Date.parse('2026-01-01T00:00:00Z');
afterEach(() => { vi.useRealTimers(); });
import { planSiteWrite } from './site-write.js';

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
#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,(42,24,53,508911),(-71,-15,-29,-58837),0.,$,$);
#90=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#91=IFCUNITASSIGNMENT((#90));`;

function revertRaw(_view: MutablePropertyView, mutation: Mutation): void {
  if (mutation.type === 'SESSION_EDIT') return;
  throw new Error(`unexpected raw ${mutation.type} in a site write history`);
}

async function session(schema: string, data = BASE) {
  const { store } = await parseModel(step(schema, data), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'm.ifc', 'model');
  const bim = new BimContext({ backend });
  const reread = async () => {
    const text = String(bim.export.ifc(undefined, {}));
    const { store: written } = await parseModel(new TextEncoder().encode(text), { disableWorkerScan: true });
    return { text, info: extractGeoreferencingOnDemand(written) };
  };
  return { bim, backend, store, reread, undo: (n: number) => undoRecordedMutationOperations(backend.getMutationView()!, n, revertRaw) };
}

/** IFC4 / IFC4X3 WHERE rules of IfcCompoundPlaneAngleMeasure, and IFC2X3 WR1-WR4. */
function satisfiesWhereRules(v: number[]): boolean {
  const [d, m, s, u] = v;
  const pos = v.every((x) => x >= 0);
  const neg = v.every((x) => x <= 0);
  return v.length >= 3 && v.length <= 4 && v.every(Number.isInteger)
    && Math.abs(m) < 60 && Math.abs(s) < 60 && (u === undefined || Math.abs(u) < 1_000_000)
    && d >= -360 && d < 360 && (pos || neg);
}

describe('IfcCompoundPlaneAngleMeasure encoding', () => {
  it.each([46.94809, -33.8688, 0, -0.5, 179.9999999, -179.9999999, 89.9999997, 7.4474, -71.258072, 42.414864, 1e-9])('%f° encodes within the WHERE rules and reads back to the millionth of a second', (deg) => {
    const angle = toCompoundPlaneAngle(deg);
    expect(satisfiesWhereRules(angle), JSON.stringify(angle)).toBe(true);
    expect(Math.abs((fromCompoundPlaneAngle(angle) as number) - deg)).toBeLessThanOrEqual(0.5 / 3_600_000_000 + 1e-15);
  });

  it('negates every component of a southern or western angle, and never writes -0', () => {
    expect(toCompoundPlaneAngle(-33.5)).toEqual([-33, -30, 0, 0]);
    expect(toCompoundPlaneAngle(-0.5)).toEqual([0, -30, 0, 0]);
    expect(Object.is(toCompoundPlaneAngle(-0.5)[0], -0)).toBe(false);
  });

  it('carries a rounding that reaches a full second, minute or degree', () => {
    expect(toCompoundPlaneAngle(10 - 1e-13)).toEqual([10, 0, 0, 0]);
  });

  it('reads the Revit export value the same way the parser does', () => {
    expect(fromCompoundPlaneAngle([-71, -15, -29, -58837])).toBeCloseTo(-71.258072, 6);
  });
});

describe('bim.georef.setSite', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'])('%s: writes the angles and elevation, which the reader takes back', async (schema) => {
    const { bim, reread } = await session(schema);
    const result = bim.georef.setSite({ RefLatitude: 46.948091, RefLongitude: 7.447441, RefElevation: 540.25 });
    expect(result.siteId).toBe(6);
    expect(result.before.RefLatitude).toBeCloseTo(42.414864, 6);
    expect(result.written.RefLatitude).toEqual(toCompoundPlaneAngle(46.948091));
    const { text, info } = await reread();
    expect(text).toMatch(/IFCSITE\('1Pbuu0tu59NfhrTsztVBK1',[^;]*\(46,56,53,127600\),\(7,26,50,787600\),540\.25,/);
    expect(info?.source).toBe('siteLocation');
    expect(info?.mapConversion?.northings).toBeCloseTo(46.948091, 9);
    expect(info?.mapConversion?.eastings).toBeCloseTo(7.447441, 9);
    // get() agrees with the export before it is written.
    expect(bim.georef.get().site).toMatchObject({ expressId: 6, elevation: 540.25 });
    expect(bim.georef.get().site?.latitude).toBeCloseTo(46.948091, 9);
  });

  it('refuses a site retyped outside georef without editing the replacement record', async () => {
    const { bim, backend } = await session('IFC4');
    bim.georef.setSite({ RefLatitude: 47, RefLongitude: 8 });
    backend.getMutationView()!.setEntityType(6, 'IfcBuilding');
    vi.useFakeTimers({ toFake: ['Date'], now: exportClock });
    const before = String(bim.export.ifc());
    expect(() => bim.georef.setSite({ RefLatitude: 47, RefLongitude: 8 })).toThrow(/retyped/);
    expect(String(bim.export.ifc())).toBe(before);
  });

  it('one undo takes the whole write back' , async () => {
    const { bim, backend, undo, reread } = await session('IFC4');
    bim.georef.setSite({ RefLatitude: -33.8688, RefLongitude: 151.2093, RefElevation: 20 });
    // One operation: the three slot edits and the history marker together.
    expect(undo(1)).toBe(4);
    expect(backend.getMutationView()?.getMutations()).toHaveLength(0);
    const { text } = await reread();
    expect(text).toContain('(42,24,53,508911),(-71,-15,-29,-58837),0.');
    expect(bim.georef.get().site?.latitude).toBeCloseTo(42.414864, 6);
  });

  it('refuses without writing: out of range, one coordinate without the other, no site, several sites', async () => {
    const refusal = (fn: () => unknown): GeoreferencingError => {
      try { fn(); } catch (err) { if (err instanceof GeoreferencingError) return err; throw err; }
      throw new Error('expected a refusal');
    };
    const { bim, backend } = await session('IFC4');
    expect(refusal(() => bim.georef.setSite({ RefLatitude: 91, RefLongitude: 0 })).missing).toEqual(['RefLatitude']);
    expect(refusal(() => bim.georef.setSite({ RefLatitude: 1, RefLongitude: 181 })).missing).toEqual(['RefLongitude']);
    expect(refusal(() => bim.georef.setSite({})).code).toBe('MISSING_INPUT');
    expect(refusal(() => bim.georef.setSite({ RefLatitude: 1, Lat: 2 } as never)).code).toBe('INVALID_INPUT');
    expect(backend.getMutationView()?.getMutations() ?? []).toHaveLength(0);

    const bare = await session('IFC4', BASE.replace('(42,24,53,508911),(-71,-15,-29,-58837),0.', '$,$,$'));
    expect(refusal(() => bare.bim.georef.setSite({ RefLatitude: 47 })).missing).toEqual(['RefLongitude']);

    const none = await session('IFC4', BASE.replace(/#6=IFCSITE[^\n]*\n/, ''));
    expect(refusal(() => none.bim.georef.setSite({ RefLatitude: 47, RefLongitude: 8 })).code).toBe('NO_ANCHOR');

    const two = await session('IFC4', `${BASE}\n#7=IFCSITE('2Pbuu0tu59NfhrTsztVBK1',$,'Site 2',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`);
    expect(refusal(() => two.bim.georef.setSite({ RefLatitude: 47, RefLongitude: 8 })).code).toBe('AMBIGUOUS');
    expect(two.bim.georef.setSite({ siteId: 7, RefLatitude: 47, RefLongitude: 8 }).siteId).toBe(7);
  });
});

// PR #10537: external positional edits must not be overwritten; own writes stay repeatable.
it('refuses an external positional location edit but allows repeated setSite writes', async () => {
  const { bim, backend } = await session('IFC4');
  bim.georef.setSite({ RefLatitude: 47, RefLongitude: 8 });
  bim.georef.setSite({ RefLatitude: 48, RefLongitude: 9 });
  const view = backend.getMutationView()!;
  view.setPositionalAttribute(6, 9, [1, 0, 0, 0]);
  vi.useFakeTimers({ toFake: ['Date'], now: exportClock });
  const before = String(bim.export.ifc());
  expect(() => bim.georef.setSite({ RefLatitude: 49, RefLongitude: 10 })).toThrow(/outside setSite/);
  expect(String(bim.export.ifc())).toBe(before);
});

// #10659: a host whose undo history holds every view edit (the viewer) reads an earlier location edit as it stands.
it("plans over an earlier positional location edit when the caller owns every edit ('all')", async () => {
  const { backend, store } = await session('IFC4');
  const view = backend.getOrCreateMutationView();
  view.setPositionalAttribute(6, 9, [1, 0, 0, 0]);
  const plan = planSiteWrite(store, view, { RefLongitude: 10 }, 'all');
  expect(plan.result.before.RefLatitude).toBe(1);
  expect(plan.edits).toEqual([[10, [10, 0, 0, 0]]]);
  expect(() => planSiteWrite(store, view, { RefLongitude: 10 })).toThrow(/outside setSite/);
});

it('reports the first valid site in the same order as the exported reader (#10537)', async () => {
  const earlier = BASE.replace('(42,24,53,508911),(-71,-15,-29,-58837),0.', '$,$,$');
  const { bim, reread } = await session('IFC4', `${earlier}\n#7=IFCSITE('2Pbuu0tu59NfhrTsztVBK1',$,'B',$,$,$,$,$,.ELEMENT.,(40,0,0,0),(10,0,0,0),0.,$,$);`);
  expect(bim.georef.get().site?.expressId).toBe(7);
  bim.georef.setSite({ siteId: 6, RefLatitude: 47, RefLongitude: 8, RefElevation: 123 });
  expect(bim.georef.get().site).toMatchObject({ expressId: 6, latitude: 47, longitude: 8, elevation: 123 });
  const { info } = await reread();
  expect(info?.mapConversion).toMatchObject({ id: 6, northings: 47, eastings: 8, orthogonalHeight: 123 });
});
