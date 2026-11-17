#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Refresh the `ifc` block of every fetched reference in manifest.json with the
// output of `ifc-lite info --json` (schema, entity count, storeys, element
// counts by class). Run after fetch-references.mjs; needs the built CLI.
//
//   node tests/modelling-parity/references/refresh-info.mjs          # rewrite manifest.json
//   node tests/modelling-parity/references/refresh-info.mjs --check  # exit 1 when it would change
//
// The file path is passed to the CLI as an argument only; nothing from a
// reference is executed.

import { isMainEntry } from '../../../scripts/lib/is-main-entry.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { verifyPath } from './fetch-references.mjs';
import { MANIFEST_PATH, ROOT, resolveReferencePath } from './lib.mjs';

// IfcProduct-level classes worth comparing; resource entities (points, loops, styles...) are noise here.
const ELEMENT = /^Ifc(Wall|Slab|Roof|Door|Window|Stair|Ramp|Railing|Column|Beam|Member|Plate|Footing|Pile|Covering|Space|BuildingStorey|Building|Site|CurtainWall|FurnishingElement|FurnitureElement|SystemFurnitureElement|BuildingElementProxy|OpeningElement|Chimney|ShadingDevice|Opening|Transport|Flow|Distribution|Duct|Pipe|Cable|Lamp|Light|Sanitary|Alarm|Sensor|Actuator|Controller|Unitary|Air|Boiler|Chiller|Coil|Fan|Pump|Valve|Tank|Electric|Fire|Heat|Humid|Space|Annotation|Grid|Geographic|Civil|Alignment|Road|Bridge|Rail|Tessellated|Benchmark|Element|Product)/;
const NOT_ELEMENT = /(Shape|Properties|Type|Style|Relationship|Rel[A-Z]|Representation|Item|Placement|Profile|Layer|Material|Quantity|Property|Measure)/;

export function elementCountsFromInfo(info) {
  return Object.fromEntries(Object.entries(info.typeCounts)
    .filter(([name]) => ELEMENT.test(name) && !NOT_ELEMENT.test(name))
    .sort(([a], [b]) => a.localeCompare(b)));
}

export async function requireVerifiedReference(file, entry) {
  const verification = await verifyPath(file, entry);
  if (verification.state !== 'ok') throw new Error(`${entry.id}: ${verification.state} ${verification.detail ?? ''}; run fetch-references.mjs`);
}

async function main() {
  const check = process.argv.includes('--check');
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of manifest.references) {
    const file = resolveReferencePath(entry);
    await requireVerifiedReference(file, entry);
    const out = execFileSync(process.execPath, [`${ROOT}/packages/cli/dist/index.js`, 'info', '--json', file], { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const info = JSON.parse(out.slice(out.indexOf('{')));
    const elementCounts = elementCountsFromInfo(info);
    entry.ifc = {
      cliSchema: info.schema,
      entityCount: info.entityCount,
      storeys: info.storeys,
      elementCounts,
      command: 'node packages/cli/dist/index.js info --json <file>',
    };
  }
  const next = JSON.stringify(manifest, null, 2) + '\n';
  if (check) {
    if (readFileSync(MANIFEST_PATH, 'utf8') !== next) { console.error('manifest.json ifc blocks are stale: run refresh-info.mjs'); process.exit(1); }
    console.log('manifest ifc blocks are up to date');
  } else { writeFileSync(MANIFEST_PATH, next); console.log('manifest.json updated'); }

}

if (isMainEntry(import.meta.url)) await main();
