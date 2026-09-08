/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pins `isQuantityProperty` / `routesToQuantityTable` classification against
 * real third-party IFC5 fixtures (buildingSMART sample scenes), not against
 * our own writer's output. `exactQuantityNames` and `suffixPatterns` in
 * property-extractor.ts are hand-maintained name lists with no prior test
 * coverage — a corpus-wide census of every `bsi::ifc::prop::*` short name
 * across tests/models/ifc5/ found no real misclassification (every name in
 * the corpus already classifies correctly), so this is a coverage gap, not
 * a bug fix. These tests pin the specific quantity/property split so a
 * future edit to either list cannot silently regress it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseIfcx } from './index.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURES_DIR = resolve(REPO_ROOT, 'tests/models/ifc5');
const HELLO_WALL_PATH = resolve(FIXTURES_DIR, 'Hello_Wall_hello-wall.ifcx');
const PCERT_ARCH_PATH = resolve(FIXTURES_DIR, 'PCERT-Sample-Scene_Building-Architecture.ifcx');
const PCERT_STRUCT_PATH = resolve(FIXTURES_DIR, 'PCERT-Sample-Scene_Building-Structural.ifcx');

// Per AGENTS.md §9 fixtures are fetched on demand; skip the suite cleanly
// when the bytes aren't on disk so a fresh checkout doesn't crash here.
const FIXTURES_AVAILABLE =
  existsSync(HELLO_WALL_PATH) && existsSync(PCERT_ARCH_PATH) && existsSync(PCERT_STRUCT_PATH);

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(copy).set(buffer);
  return copy;
}

async function parseFixture(path: string) {
  const buffer = readFileSync(path);
  return parseIfcx(toArrayBuffer(buffer));
}

function quantitiesFor(
  result: Awaited<ReturnType<typeof parseFixture>>,
  path: string
): Array<{ qset: string; name: string; value: unknown }> {
  const id = result.pathToId.get(path);
  assert.ok(id !== undefined, `path ${path} present in parsed entity table`);
  return result.quantities
    .getForEntity(id!)
    .flatMap((qset) => qset.quantities.map((q) => ({ qset: qset.name, name: q.name, value: q.value })));
}

function propertiesFor(
  result: Awaited<ReturnType<typeof parseFixture>>,
  path: string
): Array<{ name: string; value: unknown }> {
  const id = result.pathToId.get(path);
  assert.ok(id !== undefined, `path ${path} present in parsed entity table`);
  return result.properties.getForEntity(id!).flatMap((pset) => pset.properties.map((p) => ({ name: p.name, value: p.value })));
}

describe(
  'quantity classification — pinned against real IFC5 fixtures',
  { skip: !FIXTURES_AVAILABLE && 'tests/models/ifc5/*.ifcx missing — run `pnpm fixtures`' },
  () => {
    it('Hello_Wall: legacy flat bsi::ifc::prop keys extract exactly Volume+Height per element (10 quantities)', async () => {
      const result = await parseFixture(HELLO_WALL_PATH);

      const wall = quantitiesFor(result, '93791d5d-5beb-437b-b8ec-2f1f0ba4bf3b');
      assert.deepStrictEqual(
        wall.map((q) => q.name).sort(),
        ['Height', 'Volume']
      );
      assert.strictEqual(wall.find((q) => q.name === 'Height')?.value, 3);
      assert.strictEqual(wall.find((q) => q.name === 'Volume')?.value, 2.783999976);

      const space = quantitiesFor(result, 'e3035b71-bd9f-4cdc-86fd-b56e2f4605b6');
      assert.deepStrictEqual(
        space.map((q) => q.name).sort(),
        ['Height', 'Volume']
      );
      assert.strictEqual(space.find((q) => q.name === 'Height')?.value, 3);
      assert.strictEqual(space.find((q) => q.name === 'Volume')?.value, 120);

      const window = quantitiesFor(result, '25503984-6605-43a1-8597-eae657ff5bea');
      assert.deepStrictEqual(
        window.map((q) => q.name).sort(),
        ['Height', 'Volume']
      );
      assert.strictEqual(window.find((q) => q.name === 'Height')?.value, 1.2);
      assert.strictEqual(window.find((q) => q.name === 'Volume')?.value, 0.025999999592);

      // Whole-file total: wall + space + 3 windows (A, B, and the 3rd
      // window authored directly in this file), each contributing exactly
      // Volume + Height => 10 quantity rows total.
      const allIds = new Set(result.pathToId.values());
      let total = 0;
      for (const id of allIds) {
        for (const qset of result.quantities.getForEntity(id)) {
          total += qset.quantities.length;
        }
      }
      assert.strictEqual(total, 10, 'exactly 10 quantities extracted across the whole file');
    });

    it('PCERT Building-Architecture: Depth/Width/Length/NetArea/NetSideArea/NetVolume classify as quantities', async () => {
      const result = await parseFixture(PCERT_ARCH_PATH);

      // Slab (Qto_SlabBaseQuantities): NetVolume, Depth, NetArea.
      const slab = quantitiesFor(result, 'fd6c02d8-3a65-4a35-b52f-c44462cf2d51');
      assert.deepStrictEqual(
        slab.map((q) => q.name).sort(),
        ['Depth', 'NetArea', 'NetVolume']
      );
      assert.strictEqual(slab.find((q) => q.name === 'NetVolume')?.value, 6.4375);
      assert.strictEqual(slab.find((q) => q.name === 'Depth')?.value, 0.25);
      assert.strictEqual(slab.find((q) => q.name === 'NetArea')?.value, 25.75);

      // Wall (Qto_WallBaseQuantities): NetVolume, Width, Length, NetSideArea.
      const wall = quantitiesFor(result, '4a68ae33-91b6-41df-be94-04a42c5c605f');
      assert.deepStrictEqual(
        wall.map((q) => q.name).sort(),
        ['Length', 'NetSideArea', 'NetVolume', 'Width']
      );
      assert.strictEqual(wall.find((q) => q.name === 'NetVolume')?.value, 1.269265);
      assert.strictEqual(wall.find((q) => q.name === 'Width')?.value, 0.2);
      assert.strictEqual(wall.find((q) => q.name === 'Length')?.value, 1.8);
      assert.strictEqual(wall.find((q) => q.name === 'NetSideArea')?.value, 6.346325);
    });

    it('PCERT Building-Architecture: ElevationOfRefHeight/ElevationOfTerrain/NumberOfStoreys stay properties, not quantities', async () => {
      const result = await parseFixture(PCERT_ARCH_PATH);
      const buildingPath = '26fd704c-772c-422c-b09c-cc8243205408';

      // These names all end in a token ("Height") that also appears in
      // exactQuantityNames — but they are IfcSite/IfcBuilding attributes,
      // not Qto_ quantities, and must never route to the quantity table.
      const quantities = quantitiesFor(result, buildingPath);
      assert.deepStrictEqual(quantities, [], 'building entity carries zero quantities');

      const props = propertiesFor(result, buildingPath);
      assert.strictEqual(props.find((p) => p.name === 'ElevationOfRefHeight')?.value, 0);
      assert.strictEqual(props.find((p) => p.name === 'ElevationOfTerrain')?.value, 0);
      assert.strictEqual(props.find((p) => p.name === 'NumberOfStoreys')?.value, 1);
    });

    it('PCERT Building-Structural: CrossSectionArea classifies as a quantity alongside Length and NetVolume', async () => {
      const result = await parseFixture(PCERT_STRUCT_PATH);
      const beam = quantitiesFor(result, '3d8e9f86-e116-4190-91ed-5a3a2f821730');
      assert.deepStrictEqual(
        beam.map((q) => q.name).sort(),
        ['CrossSectionArea', 'Length', 'NetVolume']
      );
      assert.strictEqual(beam.find((q) => q.name === 'CrossSectionArea')?.value, 0.02);
      assert.strictEqual(beam.find((q) => q.name === 'Length')?.value, 2.7);
      assert.strictEqual(beam.find((q) => q.name === 'NetVolume')?.value, 0.054);
    });
  }
);
