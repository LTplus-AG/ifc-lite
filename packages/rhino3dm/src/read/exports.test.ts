/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isValidIfcGuid } from '@ifc-lite/encoding';
import { describe, expect, test } from 'vitest';
import { readRhino3dm, writeRhino3dm, type RhinoImport, type RhinoSceneManifest } from '../index.js';
import { entityBounds } from '../../test-support/craft.js';
import { userString } from './identity.js';

/**
 * Round trip of ifc-lite's own exports: IFC fixture, Rust scene builder
 * (`@ifc-lite/wasm/rhino`), `writeRhino3dm`, then `readRhino3dm`. Skips when
 * the fixtures (`pnpm fixtures`) or the Rhino wasm payload
 * (`scripts/build-wasm.sh`) are absent; CI has both.
 */
const models = fileURLToPath(new URL('../../../../tests/models/ara3d/', import.meta.url));
const wasm = (() => {
  try { return createRequire(import.meta.url).resolve('@ifc-lite/wasm/rhino_bg.wasm'); } catch { return null; }
})();
const missing = !wasm || !existsSync(wasm) ? 'the Rhino wasm payload is not built (scripts/build-wasm.sh)'
  : ['AC20-FZK-Haus.ifc', 'duplex.ifc'].some(name => !existsSync(models + name)) ? 'fixtures are absent (pnpm fixtures)' : null;

let engine: Promise<typeof import('@ifc-lite/wasm/rhino')> | undefined;
async function exported(ifc: Uint8Array, options: Record<string, unknown> = {}): Promise<{ manifest: RhinoSceneManifest; bytes: Uint8Array }> {
  engine ??= import('@ifc-lite/wasm/rhino').then(module => { module.initSync({ module: readFileSync(wasm!) }); return module; });
  const scene = (await engine).exportRhinoScene(ifc, JSON.stringify(options));
  try {
    const encoded = { manifest: scene.manifest, blob: scene.blob };
    return { manifest: JSON.parse(encoded.manifest) as RhinoSceneManifest, bytes: (await writeRhino3dm(encoded)).bytes };
  } finally { scene.free(); }
}
const fixture = (name: string) => new Uint8Array(readFileSync(models + name));

/** FZK with its site moved to a survey-scale origin, the case `IFC::WorldFromModel` exists for. */
function farFzk(): Uint8Array {
  const text = readFileSync(models + 'AC20-FZK-Haus.ifc', 'latin1');
  const moved = text.replace('#115= IFCLOCALPLACEMENT($,#114);',
    '#115= IFCLOCALPLACEMENT($,#9999991);\n#9999991= IFCAXIS2PLACEMENT3D(#9999992,$,$);\n#9999992= IFCCARTESIANPOINT((2600000.,1200000.,400.));');
  if (moved === text) throw new Error('the FZK fixture no longer has the site placement this test moves');
  return new Uint8Array(Buffer.from(moved, 'latin1'));
}

/** Worst distance between two imports' bounding box corners, per GlobalId. */
function worstCornerGap(a: RhinoImport, b: RhinoImport): number {
  const index = new Map(b.entities.map((e, i) => [e.globalId, i]));
  let worst = 0;
  a.entities.forEach((entity, i) => {
    const other = index.get(entity.globalId);
    if (other === undefined) throw new Error(`${entity.globalId} is missing from the second import`);
    const x = entityBounds(a, i), y = entityBounds(b, other);
    for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(x.min[k] - y.min[k]), Math.abs(x.max[k] - y.max[k]));
  });
  return worst;
}

// Each test builds one to four exports; a cold export of duplex alone takes over a second.
describe.skipIf(missing)(`ifc-lite exports read back${missing ? ` (skipped: ${missing})` : ''}`, { timeout: 120_000 }, () => {
  test.each([
    ['AC20-FZK-Haus.ifc', 90, 16],
    ['duplex.ifc', 236, 46],
  ])('%s: one entity per GlobalId, with its class, merged parts and valid ids', async (name, distinct, merged) => {
    const { manifest, bytes } = await exported(fixture(name));
    const result = await readRhino3dm(bytes);
    const stated = new Map<string, string>();
    for (const o of manifest.objects) {
      const id = userString(o.userStrings, 'IFC::GlobalId')!;
      if (!stated.has(id)) stated.set(id, userString(o.userStrings, 'IFC::Class')!);
    }
    expect(stated.size).toBe(distinct);
    expect(result.document).toMatchObject({ provenance: 'ifc-lite', frame: 'file' });
    expect(result.entities).toHaveLength(distinct);
    // Same ids, same class for each: a stronger statement than an equal histogram.
    expect(new Map(result.entities.map(e => [e.globalId, e.ifcClass]))).toEqual(stated);
    expect(result.entities.every(e => isValidIfcGuid(e.globalId))).toBe(true);
    expect(result.entities.filter(e => e.objectIds.length > 1)).toHaveLength(merged);
    expect(result.entities.reduce((n, e) => n + e.objectIds.length, 0)).toBe(manifest.objects.length);
    expect(result.entities.some(e => e.ifcClass === 'IfcBuildingElementProxy' && stated.get(e.globalId) !== 'IfcBuildingElementProxy')).toBe(false);
    // The exporter hides its IfcSpace layers, and the entities follow.
    const spaces = result.entities.filter(e => e.ifcClass === 'IfcSpace');
    expect(spaces.length).toBeGreaterThan(0);
    expect(spaces.every(e => e.hidden)).toBe(true);
    expect(result.entities.some(e => e.ifcClass === 'IfcWallStandardCase' && e.hidden)).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.skipped).toEqual({});
  });

  test('a known FZK wall keeps its identity and Pset_WallCommon values', async () => {
    const { bytes } = await exported(fixture('AC20-FZK-Haus.ifc'));
    const wall = (await readRhino3dm(bytes)).entities.find(e => e.globalId === '2XPyKWY018sA1ygZKgQPtU')!;
    expect(wall).toMatchObject({ ifcClass: 'IfcWallStandardCase', name: 'Wand-Int-ERDG-4' });
    // #15079 in the fixture: Pset_WallCommon with the single property ThermalTransmittance 1.5.
    expect(wall.propertySets.find(s => s.name === 'Pset_WallCommon')!.properties).toEqual([['ThermalTransmittance', '1.5']]);
  });

  test('instanced blocks land where the --no-instancing export puts the same elements', async () => {
    const ifc = fixture('duplex.ifc');
    const instanced = await readRhino3dm((await exported(ifc)).bytes);
    const flat = await readRhino3dm((await exported(ifc, { instancing: false })).bytes);
    expect(instanced.instances.length).toBeGreaterThan(0);
    expect(flat.instances).toEqual([]);
    expect(worstCornerGap(instanced, flat)).toBeLessThan(1e-6);
    expect(worstCornerGap(await readRhino3dm((await exported(ifc)).bytes, { bakeInstances: true }), flat)).toBeLessThan(1e-6);
  });

  test('a far-origin model exported local and world agrees after import, and world is not shifted twice', async () => {
    const ifc = farFzk();
    const local = await readRhino3dm((await exported(ifc, { coordinates: 'local' })).bytes);
    const world = await readRhino3dm((await exported(ifc, { coordinates: 'world' })).bytes);
    expect(local.document.frame).toBe('ifc-world-from-model');
    expect(world.document.frame).toBe('file');
    expect(worstCornerGap(local, world)).toBeLessThan(1e-6);
    const { min } = entityBounds(world, 0);
    expect(Math.abs(min[0] - 2_600_000)).toBeLessThan(100);
    expect(Math.abs(min[1] - 1_200_000)).toBeLessThan(100);
  });
});

