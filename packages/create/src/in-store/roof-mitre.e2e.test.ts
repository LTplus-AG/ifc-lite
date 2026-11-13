/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { addRoofToStore } from './roof.js';
import { exportText, newStorey, parse } from './wall-join-mesh.oracle.js';

const python = process.env.IFCOPENSHELL_PYTHON ?? 'python3';
const hasOracle = spawnSync(python, ['-c', 'import ifcopenshell, ifcopenshell.geom'], { encoding: 'utf8' }).status === 0;
it.skipIf(!hasOracle).each(['IFC4', 'IFC2X3', 'IFC4X3'] as const)('%s: 30° and 45° planes at 0.25 m share a true ridge face (#9357)', async schema => {
  const s = await newStorey(schema);
  addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: .25,
    EdgeSlopes: [Math.PI / 6, 0, Math.PI / 4, 0] });
  const text = exportText(s);
  const reopened = await parse(text);
  expect(reopened.entityIndex.byType.get('IFCROOF')).toHaveLength(1);
  const run = spawnSync(python, [fileURLToPath(new URL('./__test__/roof-mitre-oracle.py', import.meta.url))],
    { input: text, encoding: 'utf8', timeout: 30_000 });
  expect(run.status, run.stderr || run.stdout).toBe(0);
  expect(JSON.parse(run.stdout).planes).toBe(2);
});
