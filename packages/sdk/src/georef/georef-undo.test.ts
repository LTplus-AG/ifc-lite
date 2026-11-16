/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A georeferencing write is atomic with respect to undo: after any number of
 * undo steps the model holds either the complete georeferencing before a
 * write or the complete one after it, the export references nothing it does
 * not define, and `bim.georef.get()` reports exactly what re-parsing that
 * export gives.
 *
 * Undo here is `undoRecordedMutationOperations`, the path MCP
 * `mutation_undo` takes (its raw dispatcher is mirrored for DELETE_ENTITY).
 * The headless `bim.mutate.undo` / `redo` walk no history and answer
 * `false` (`headless-mutate.ts`), and no headless redo exists; the last test
 * pins that they leave a georeferencing write alone.
 */

import { describe, expect, it } from 'vitest';
import { parseModel } from '@ifc-lite/parser';
import { undoRecordedMutationOperations, recordCompoundMutation, StoreEditor, type MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
import { HeadlessBackend } from '../headless.js';
import { BimContext } from '../context.js';
import { readGeoreferencing } from './read.js';
import type { GeoreferencingSetInput, GeoreferencingState } from './types.js';

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
const GEOREFERENCED = `${BASE}
#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#90);
#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`;

const NEW: GeoreferencingSetInput = {
  ProjectedCRS: { Name: 'EPSG:2056', MapUnit: 'METRE' },
  MapConversion: { Eastings: 2600000, Northings: 1200000, OrthogonalHeight: 400 },
  replace: true,
};

/** Every `#N` the export references without defining it. */
function findDanglingRefs(content: string): number[] {
  const body = content.slice(content.indexOf('DATA;'));
  const defined = new Set<number>();
  for (const m of body.matchAll(/(^|\n)#(\d+)\s*=/g)) defined.add(+m[2]);
  const dangling = new Set<number>();
  for (const m of body.replace(/'[^']*'/g, "''").matchAll(/#(\d+)/g)) {
    if (!defined.has(+m[1])) dangling.add(+m[1]);
  }
  return [...dangling].sort((a, b) => a - b);
}

/** The comparable part of a state: what the file says, not where it came from. */
function comparable(state: GeoreferencingState) {
  const strip = <T extends object | null>(o: T) => {
    if (!o) return o;
    const { expressId: _id, ...rest } = o as Record<string, unknown>;
    return rest;
  };
  return {
    hasGeoreference: state.hasGeoreference,
    source: state.source,
    ProjectedCRS: strip(state.ProjectedCRS),
    MapConversion: strip(state.MapConversion),
    RigidOperation: strip(state.RigidOperation),
    rotationDegrees: state.rotationDegrees,
  };
}

/** MCP mutation_undo's raw dispatcher, for the mutation types a georeferencing write produces. */
function revertRaw(view: MutablePropertyView, mutation: Mutation): void {
  if (mutation.type === 'DELETE_ENTITY') view.restoreFromTombstone(mutation.entityId);
  else if (mutation.type === 'SESSION_EDIT') return;
  else throw new Error(`unexpected raw ${mutation.type} in a georeferencing history`);
}

async function session(schema: string, data: string) {
  const { store } = await parseModel(step(schema, data), { disableWorkerScan: true });
  const backend = new HeadlessBackend(store, 'm.ifc', 'model');
  const bim = new BimContext({ backend });
  const undo = (n: number) => undoRecordedMutationOperations(backend.getMutationView()!, n, revertRaw);
  /** The export references nothing it lacks, and get() is what re-parsing it reads. */
  const consistent = async (): Promise<GeoreferencingState> => {
    const text = String(bim.export.ifc());
    expect(findDanglingRefs(text)).toEqual([]);
    const { store: reparsed } = await parseModel(new TextEncoder().encode(text), { disableWorkerScan: true });
    const fromFile = readGeoreferencing(reparsed);
    expect(comparable(bim.georef.get())).toEqual(comparable(fromFile));
    return fromFile;
  };
  return { bim, backend, undo, consistent, store };
}

describe('bim.georef writes are atomic under undo', () => {
  it('one undo step takes back a whole replace: no dangling CRS, get() equals the export', async () => {
    const { bim, undo, consistent } = await session('IFC4', GEOREFERENCED);
    const original = comparable(await consistent());
    bim.georef.set(NEW);
    expect((await consistent()).MapConversion?.Eastings).toBe(2600000);
    expect(undo(1)).toBeGreaterThan(0);
    expect(comparable(await consistent())).toEqual(original);
    expect(bim.georef.get().pending).toBe(false);
  });

  it('walks back set → update → remove one write per step, then all at once', async () => {
    const { bim, undo, consistent } = await session('IFC4', GEOREFERENCED);
    const original = comparable(await consistent());
    bim.georef.set(NEW);
    const afterSet = comparable(await consistent());
    bim.georef.update({ MapConversion: { OrthogonalHeight: 401 } });
    const afterUpdate = comparable(await consistent());
    expect(afterUpdate.MapConversion).toMatchObject({ OrthogonalHeight: 401 });
    bim.georef.remove();
    expect((await consistent()).hasGeoreference).toBe(false);

    undo(1);
    expect(comparable(await consistent())).toEqual(afterUpdate);
    undo(1);
    expect(comparable(await consistent())).toEqual(afterSet);
    undo(1);
    expect(comparable(await consistent())).toEqual(original);

    // The same three writes, undone in one call of 3 and in one of 2.
    bim.georef.set(NEW);
    bim.georef.update({ MapConversion: { OrthogonalHeight: 401 } });
    bim.georef.remove();
    undo(2);
    expect(comparable(await consistent())).toEqual(afterSet);
    bim.georef.update({ MapConversion: { OrthogonalHeight: 401 } });
    bim.georef.remove();
    undo(3);
    expect(comparable(await consistent())).toEqual(original);
  });

  it('an IFC2X3 property-set write is undone as a whole', async () => {
    const { bim, undo, consistent } = await session('IFC2X3', BASE);
    const original = comparable(await consistent());
    bim.georef.set({ ...NEW, ProjectedCRS: { ...NEW.ProjectedCRS, Description: 'CH1903+ / LV95' }, replace: undefined });
    expect((await consistent()).source).toBe('ePSet_MapConversion');
    undo(1);
    expect(comparable(await consistent())).toEqual(original);
  });

  it('a georeferencing record deleted outside bim.georef is not reported', async () => {
    const { bim, backend, consistent } = await session('IFC4', GEOREFERENCED);
    expect(bim.store.removeEntity({ modelId: 'model', expressId: 21 })).toBe(true);
    expect(backend.getMutationView()!.isDeleted(21)).toBe(true);
    expect(bim.georef.get().MapConversion).toBeNull();
    await consistent();
  });

  it('a conversion deleted after a partial update is not reported, and no 0/0 conversion is exported', async () => {
    const { bim, backend } = await session('IFC4', GEOREFERENCED);
    bim.georef.update({ MapConversion: { OrthogonalHeight: 11 } });
    expect(bim.georef.get().MapConversion).toMatchObject({ Eastings: 1, Northings: 2, OrthogonalHeight: 11 });
    expect(bim.store.removeEntity({ modelId: 'model', expressId: 21 })).toBe(true);
    expect(backend.getMutationView()!.isDeleted(21)).toBe(true);
    // (a) get() does not keep the deleted record's coordinates.
    expect(bim.georef.get().MapConversion).toBeNull();
    // (b) The pending height-only edit has no record to edit and is not a complete conversion:
    // the export is refused with the cause named, never written with Eastings/Northings 0.
    expect(() => bim.export.ifc()).toThrow(/Cannot create IfcMapConversion from a partial edit/);
  });

  it('an IfcSite deleted outside bim.georef stops supplying the latitude/longitude fallback', async () => {
    const SITE = `${BASE}`.replace("#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);", "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,0,0),(8,32,0,0),12.,$,$);");
    expect(SITE).not.toBe(BASE);
    // Without any georeferencing record the site is the whole georeference.
    const a = await session('IFC4', SITE);
    expect((await a.consistent()).hasGeoreference).toBe(true);
    a.bim.store.removeEntity({ modelId: 'model', expressId: 6 });
    expect(a.bim.georef.get().hasGeoreference).toBe(false);
    await a.consistent();
    // With a conversion, after remove() only the site is left; deleting it leaves nothing.
    const b = await session('IFC4', `${SITE}\n#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#90);\n#21=IFCMAPCONVERSION(#5,#20,1.,2.,3.,$,$,$);`);
    b.bim.georef.remove();
    expect(b.bim.georef.get().hasGeoreference).toBe(true);
    b.bim.store.removeEntity({ modelId: 'model', expressId: 6 });
    expect(b.bim.georef.get().hasGeoreference).toBe(false);
    await b.consistent();
  });

  it('a MapUnit re-pointed by position is not carried over from a stale read', async () => {
    const { bim, backend } = await session('IFC4', `${GEOREFERENCED.replace('#20=IFCPROJECTEDCRS(\'EPSG:2056\',$,$,$,$,$,#90);', "#95=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);\n#20=IFCPROJECTEDCRS('EPSG:2056',$,$,$,$,$,#95);")}`);
    expect(bim.georef.get().ProjectedCRS).toMatchObject({ MapUnit: 'MILLIMETRE', mapUnitResolved: true });
    bim.mutate.setAttribute({ modelId: 'model', expressId: 6 }, 'Description', 'x'); // opens the session's mutation view
    backend.getMutationView()!.setPositionalAttribute(20, 6, '#90' as never);
    expect(bim.georef.get().ProjectedCRS?.mapUnitResolved).toBe(false);
    expect(() => bim.georef.set({ ...NEW, ProjectedCRS: { Name: 'EPSG:2056' } })).toThrow(/MapUnit is required/);
  });

  it('IFC2X3: after remove() with an IfcSite fallback, get, a second remove, update, set and the export agree', async () => {
    const SITE_LL = BASE.replace("#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);", "#6=IFCSITE('1Pbuu0tu59NfhrTsztVBK1',$,'Site',$,$,$,$,$,.ELEMENT.,(47,22,0,0),(8,32,0,0),12.,$,$);");
    const { bim, consistent } = await session('IFC2X3', SITE_LL);
    bim.georef.set({ ...NEW, replace: undefined });
    expect((await consistent()).source).toBe('ePSet_MapConversion');
    bim.georef.remove();
    // Only the site fallback is left, and get() is what re-parsing the export reads.
    const after = bim.georef.get();
    expect(after).toMatchObject({ hasGeoreference: true, MapConversion: null, ProjectedCRS: null });
    expect(after.site).not.toBeNull();
    await consistent();
    // The site fallback is not something remove() can take away: a second remove refuses, it is not a silent no-op.
    expect(() => bim.georef.remove()).toThrow(/carries no/);
    // update has nothing to edit and refuses; set writes the sets anew without `replace`.
    expect(() => bim.georef.update({ MapConversion: { Eastings: 1, Northings: 2, OrthogonalHeight: 3 } })).toThrow(/The model has no IfcMapConversion/);
    bim.georef.set({ ...NEW, replace: undefined });
    expect((await consistent()).source).toBe('ePSet_MapConversion');
  });

  it('bim.mutate.undo / redo (no history on this backend) leave a georeferencing write in place', async () => {
    const { bim, consistent } = await session('IFC4', GEOREFERENCED);
    bim.georef.set(NEW);
    const after = comparable(await consistent());
    expect(bim.mutate.undo('model')).toBe(false);
    expect(bim.mutate.redo('model')).toBe(false);
    expect(comparable(await consistent())).toEqual(after);
  });
});

for (const schema of ['IFC4', 'IFC2X3']) {
  it(`${schema}: remove with site fallback permits a fresh complete set without replace (#10382 review)`, async () => {
    const site = BASE.replace('.ELEMENT.,$,$,$,$,$);', '.ELEMENT.,(47,22,0,0),(8,32,0,0),12.,$,$);');
    const m = await session(schema, site);
    m.bim.georef.set({ ...NEW, replace: undefined });
    m.bim.georef.remove();
    expect(m.bim.georef.get()).toMatchObject({ hasGeoreference: true, ProjectedCRS: null, MapConversion: null });
    m.bim.georef.set({ ...NEW, replace: undefined, MapConversion: { Eastings: 7, Northings: 8, OrthogonalHeight: 9 } });
    expect((await m.consistent()).MapConversion?.Eastings).toBe(7);
  });
}

it('undoing deletion of a created marker host restores its pending write (#10382 review)', async () => {
  const data = BASE.replace('(#5)', '()').replace("#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#3,$);", '');
  const m = await session('IFC4', data);
  const editor = m.backend.ensureEditor();
  const host = editor.addEntity('IfcGeometricRepresentationContext', [null, 'Model', 3, 0.00001, { literal: '#3' }, null]);
  m.bim.georef.set({ ...NEW, replace: undefined });
  const view = m.backend.getMutationView()!;
  expect(view.getMutations().some((entry) => entry.type === 'SESSION_EDIT' && entry.entityId === host.expressId)).toBe(true);
  recordCompoundMutation(view, (draft) => new StoreEditor(m.store, draft).removeEntity(host.expressId));
  expect(view.getMutations().some((entry) => entry.type === 'SESSION_EDIT')).toBe(false);
  m.bim.georef.get(); // Reading while the marker is hidden must not discard its pending write.
  m.undo(1);
  expect((await m.consistent()).MapConversion?.Eastings).toBe(2600000);
});

it('a new write after undo cannot revive the abandoned write (#10382 review)', async () => {
  const m = await session('IFC4', GEOREFERENCED);
  m.bim.georef.update({ MapConversion: { Eastings: 99 } });
  m.undo(1);
  expect(m.bim.georef.get().MapConversion?.Eastings).toBe(1);
  m.bim.georef.update({ MapConversion: { Eastings: 88 } });
  expect((await m.consistent()).MapConversion?.Eastings).toBe(88);
  expect(m.bim.mutate.redo('model')).toBe(false); // This backend exposes no redo history.
  m.undo(1);
  expect((await m.consistent()).MapConversion?.Eastings).toBe(1);
});
