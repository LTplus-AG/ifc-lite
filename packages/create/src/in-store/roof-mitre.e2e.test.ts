/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { addRoofToStore } from './roof.js';
import { editFootprintRoofInStore } from './roof-footprint.js';
import { recordCompoundMutation, StoreEditor, undoRecordedMutationOperations } from '@ifc-lite/mutations';
import { exportText, insideMesh, newStorey, parse, type Mesh } from './wall-join-mesh.oracle.js';

const python = process.env.IFCOPENSHELL_PYTHON ?? 'python3';
const hasOracle = spawnSync(python, ['-c', 'import ifcopenshell, ifcopenshell.geom'], { encoding: 'utf8' }).status === 0;
// A complete independent EXPRESS validation and CAD meshing need their own budget.
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
}, 15_000);

const D = Math.PI / 180;
const RECT: Array<[number, number]> = [[0, 0], [10, 0], [10, 8], [0, 8]];
const REFLEX: Array<[number, number]> = [[0, 0], [10, 0], [10, 3], [4, 3], [4, 8], [0, 8]];
// Each case invokes an independent CAD kernel plus a complete EXPRESS validation.
it.skipIf(!hasOracle).each([
  { name: 'four-way hip', outline: RECT, slopes: [20, 35, 45, 60], overhang: 0 },
  { name: 'overhanging hip', outline: RECT, slopes: [30, 45, 30, 45], overhang: .4 },
  { name: 'valley', outline: REFLEX, slopes: [30, 45, 30, 45, 30, 45], overhang: 0 },
])('$name: independent faces coincide and quantities measure the mitred solids (#9357)', async ({ outline, slopes, overhang }) => {
  const s = await newStorey();
  const roof = addRoofToStore(s.editor, s.anchor, { Profile: 'polygon', OuterCurve: outline, Thickness: .25,
    EdgeSlopes: slopes.map(v => v * D), Overhang: overhang });
  const check = (text: string) => {
    const run = spawnSync(python, [fileURLToPath(new URL('./__test__/roof-mitre-surface-oracle.py', import.meta.url))],
      { input: text, encoding: 'utf8', timeout: 30_000 });
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(JSON.parse(run.stdout).sharedFaces).toBeGreaterThan(0);
  };
  const text = exportText(s);
  check(text);
  // Change pitch and thickness together, then Undo and export/reopen again.
  recordCompoundMutation(s.view, view => editFootprintRoofInStore(s.store, new StoreEditor(s.store, view), roof.roofId,
    { Edge: { Index: 0, Slope: 32 * D }, Thickness: .3 }));
  check(exportText(s));
  undoRecordedMutationOperations(s.view, 1, () => { throw new Error('one compound roof edit expected'); });
  check(exportText(s));
  expect((await parse(exportText(s))).entityIndex.byType.get('IFCROOF')).toHaveLength(1);
}, 30_000);

const wasmPath = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
it.skipIf(!existsSync(wasmPath))('the real WASM kernel meshes the mitred 30°/45° ridge after all schema exports (#9357)', async () => {
  initSync({ module: readFileSync(wasmPath) });
  const api = new IfcAPI();
  const a = Math.PI / 6, b = Math.PI / 4, thickness = .25;
  const topY = (8 * Math.tan(b) + thickness / Math.cos(b) - thickness / Math.cos(a)) / (Math.tan(a) + Math.tan(b));
  const topZ = 3 + Math.tan(a) * topY + thickness / Math.cos(a);
  for (const schema of ['IFC4', 'IFC2X3', 'IFC4X3'] as const) {
    const s = await newStorey(schema);
    const roof = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 3], Width: 10, Depth: 8, Thickness: thickness,
      EdgeSlopes: [a, 0, b, 0] });
    const bytes = new TextEncoder().encode(exportText(s)), pre = api.buildPrePassOnce(bytes);
    const meshes: Mesh[] = [];
    try {
      const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, 0, 0, 0, false,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          try {
            if (mesh.expressId !== roof.roofId) continue;
            const origin = mesh.origin, positions = Float64Array.from(mesh.positions);
            for (let j = 0; j < positions.length; j++) positions[j] += origin[j % 3];
            meshes.push({ positions, indices: mesh.indices.slice() });
          } finally { mesh.free(); }
        }
      } finally { collection.free(); }
    } finally { api.clearPrePassCache(); }
    expect(meshes.length).toBeGreaterThan(0);
    const heights = meshes.flatMap(mesh => Array.from(mesh.positions).filter((_, i) => i % 3 === 1));
    expect(Math.max(...heights)).toBeCloseTo(topZ, 4);
    for (const y of [topY - .04, topY + .04]) {
      const top = 3 + Math.min(Math.tan(a) * y + thickness / Math.cos(a), Math.tan(b) * (8-y) + thickness / Math.cos(b));
      expect(insideMesh(meshes, [4.83, top-.015, -y])).toBe(true);
      expect(insideMesh(meshes, [4.83, top+.015, -y])).toBe(false);
    }
  }
});
