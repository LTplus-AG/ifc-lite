/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isValidIfcGuid, type RandomSource } from '@ifc-lite/encoding';
import { getInheritanceChainAcrossSchemas, parseModel } from '@ifc-lite/parser';
import { HeadlessBackend, openModel } from '../headless.js';
import { BimContext } from '../context.js';
import type { HeadlessBackendOptions } from './options.js';

const SAMPLE = new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url);

/** mulberry32: a small seeded `[0, 1)` source, enough to make runs repeatable. */
function seeded(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One session authoring through every GlobalId-writing path a plan editor uses. */
async function authoredExport(guidRandom: RandomSource): Promise<string> {
  const model = await openModel(readFileSync(SAMPLE), { modelId: 'm', disableWorkerScan: true, backend: { guidRandom } });
  try {
    const { bim } = model, S = bim.store;
    const home = S.listStoreyLevels('m')[0].expressId;
    const upper = S.addStorey('m', { Name: 'Upper', Elevation: 3 });
    const a = S.addWall('m', home, { Start: [0, 10, 0], End: [6, 10, 0], Thickness: 0.2, Height: 3 });
    const b = S.addWall('m', home, { Start: [6, 10, 0], End: [6, 14, 0], Thickness: 0.2, Height: 3 });
    S.joinWalls('m', a.expressId, b.expressId);
    S.addHostedDoor('m', a.expressId, { Offset: 1, Width: 0.9, Height: 2.1 });
    S.addHostedWindow('m', b.expressId, { Offset: 1, Width: 1.2, Height: 1.2, Sill: 0.9 });
    S.addSpace('m', home, { Profile: 'polygon', OuterCurve: [[0, 10], [6, 10], [6, 14], [0, 14]], Height: 3, Name: 'Room' });
    S.addGrid('m', home, { Name: 'Grid', UAxes: [{ Tag: 'A', Start: [0, 0], End: [0, 20] }], VAxes: [{ Tag: '1', Start: [-1, 0], End: [10, 0] }] });
    S.copyElements('m', [a.expressId], [{ offset: [0, 6, 0] }]);
    S.copyToStoreys('m', [b.expressId], [upper.expressId]);
    const c = S.addWall('m', home, { Start: [10, 10, 0], End: [12, 10, 0], Thickness: 0.2, Height: 3 });
    S.mirrorElements('m', [c.expressId], { axis: [[0, 20], [1, 20]], copy: true });
    S.splitElements('m', [{ expressId: c.expressId, cut: { kind: 'wall', distance: 1 } }]);
    bim.mutate.setProperty(a, 'Pset_WallCommon', 'IsExternal', true);
    const content = bim.export.ifc();
    return typeof content === 'string' ? content : new TextDecoder().decode(content);
  } finally { model.close(); }
}

const dataSection = (step: string) => step.slice(step.indexOf('DATA;'));

/** The first attribute of every IfcRoot record, as written: rootedness comes from the schema, not from the value. */
function rootGlobalIds(step: string): string[] {
  return [...step.matchAll(/^#\d+\s*=\s*([A-Z0-9_]+)\s*\(\s*([^,)]*)/gm)]
    .filter((m) => getInheritanceChainAcrossSchemas(m[1]).includes('IfcRoot'))
    .map((m) => m[2].trim().replace(/^'(.*)'$/, '$1'));
}

function authoredGlobalIds(step: string, source: string): string[] {
  const before = new Set(rootGlobalIds(source));
  return rootGlobalIds(step).filter((id) => !before.has(id));
}

describe('HeadlessBackendOptions.guidRandom (#10963)', () => {
  it('makes authored GlobalIds, and so the export, reproducible from the seed', async () => {
    const source = readFileSync(SAMPLE, 'utf8');
    const first = await authoredExport(seeded(42));
    const again = await authoredExport(seeded(42));
    const other = await authoredExport(seeded(7));
    const authored = authoredGlobalIds(first, source);
    expect(authored.length).toBeGreaterThan(15);
    expect(authored.every(isValidIfcGuid)).toBe(true);
    expect(new Set(authored).size).toBe(authored.length);
    expect(authoredGlobalIds(again, source)).toEqual(authored);
    expect(dataSection(again)).toBe(dataSection(first));
    expect(authoredGlobalIds(other, source)).not.toEqual(authored);
  });

  it('keeps the source it was constructed with when the caller replaces it later', async () => {
    const { store } = await parseModel(readFileSync(SAMPLE), { disableWorkerScan: true });
    const options: HeadlessBackendOptions = { guidRandom: seeded(3) };
    const backend = new HeadlessBackend(store, 'hello-wall.ifc', 'm', options);
    let late = 0;
    options.guidRandom = () => { late++; return Math.random(); };
    const S = new BimContext({ backend }).store;
    S.addWall('m', S.listStoreyLevels('m')[0].expressId, { Start: [0, 10, 0], End: [6, 10, 0], Thickness: 0.2, Height: 3 });
    expect(late).toBe(0);
  });

  it('collects a malformed or missing GlobalId of an authored root instead of skipping it', () => {
    const step = ['DATA;', "#1=IFCWALL('bad',$,'W',$,$,$,$,$,$);", '#2=IFCRELAGGREGATES($,$,$,$,#3,(#1));', '#3=IFCCARTESIANPOINT((0.,0.,0.));', 'ENDSEC;'].join('\n');
    const ids = authoredGlobalIds(step, '');
    expect(ids).toEqual(['bad', '$']);
    expect(ids.every(isValidIfcGuid)).toBe(false);
  });

  it.each([['seeded', seeded(1)], ['unseeded', undefined]])('keeps the source Name on %s copies', async (_, guidRandom) => {
    const model = await openModel(readFileSync(SAMPLE), { modelId: 'm', disableWorkerScan: true, backend: { guidRandom } });
    try {
      const { bim } = model, S = bim.store;
      const home = S.listStoreyLevels('m')[0].expressId;
      const upper = S.addStorey('m', { Name: 'Upper', Elevation: 3 });
      const wall = S.addWall('m', home, { Start: [0, 10, 0], End: [6, 10, 0], Thickness: 0.2, Height: 3, Name: 'W1' });
      const [copy] = S.copyElements('m', [wall.expressId], [{ offset: [0, 6, 0] }]);
      const [arrayed] = S.arrayElements('m', [wall.expressId], { mode: 'linear', count: 2, anchor: [0, 0], cursor: [0, 3], distance: 3 });
      const [{ refs: [onUpper] }] = S.copyToStoreys('m', [wall.expressId], [upper.expressId]);
      expect([copy, arrayed, onUpper].map((r) => bim.entity(r)?.name)).toEqual(['W1', 'W1', 'W1']);
    } finally { model.close(); }
  });
});
