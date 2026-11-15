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
import { undoRecordedMutationOperations, type MutablePropertyView, type Mutation } from '@ifc-lite/mutations';
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
  return { bim, backend, undo, consistent };
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

  it('bim.mutate.undo / redo (no history on this backend) leave a georeferencing write in place', async () => {
    const { bim, consistent } = await session('IFC4', GEOREFERENCED);
    bim.georef.set(NEW);
    const after = comparable(await consistent());
    expect(bim.mutate.undo('model')).toBe(false);
    expect(bim.mutate.redo('model')).toBe(false);
    expect(comparable(await consistent())).toEqual(after);
  });
});
