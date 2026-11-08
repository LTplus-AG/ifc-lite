/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Roof by footprint (#9296 round 3) through the parts a user reaches: author
 * on a parsed storey through the overlay, export with `StepExporter` in every
 * schema, re-parse, mesh with the real kernel, edit and read the quantities.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { deriveAuthoredBaseQuantities } from './base-quantities.js';
import { resolveSlabEditChain } from './edit/slab-edit.js';
import { addRoofToStore } from './roof.js';
import { requiredModule } from './__test__/required-module.js';
import { exportText, newStorey, parse, type Schema } from './wall-join-mesh.oracle.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const D = Math.PI / 180;
const HIP = { Position: [0, 0, 3] as [number, number, number], Width: 10, Depth: 8, Thickness: 0.25, EdgeSlopes: [30 * D, 30 * D, 30 * D, 30 * D] };

async function storey(schema: Schema = 'IFC4') {
  const s = await newStorey(schema);
  s.view.setQuantityExtractor((id, asking, occurrence) => {
    const own = extractQuantitiesOnDemand(s.store, id);
    return own.length > 0 ? own : deriveAuthoredBaseQuantities(s.store, asking, occurrence);
  });
  return s;
}

/** Loaded per test, so a revert of the footprint roof fails these assertions rather than this file's load. */
let f: typeof import('./roof-footprint.js');
beforeEach(async () => { f = await requiredModule(() => import('./roof-footprint.js'), 'the roof-by-footprint builder exists (#9296)'); });

const roofRecord = (text: string) => /#\d+=IFCROOF\(([^;]*)\);/.exec(text)?.[1] ?? '';

describe('a roof by footprint in a loaded model (#9296 round 3)', () => {
  it.each(['IFC4', 'IFC2X3', 'IFC4X3'] as const)('%s: one IfcRoof with a solid per plane, its type and its definition survive export', async (schema) => {
    const s = await storey(schema);
    const built = addRoofToStore(s.editor, s.anchor, HIP);
    expect(built.solidIds).toHaveLength(4);
    const text = exportText(s);
    expect(roofRecord(text)).toMatch(/\.HIP_ROOF\.\s*$/);
    expect(text).toContain(`'${f.ROOF_FOOTPRINT_PSET}'`);
    const reopened = await parse(text);
    const roofId = reopened.entityIndex.byType.get('IFCROOF')?.[0];
    expect(roofId).toBeDefined();
    const names = extractPropertiesOnDemand(reopened, roofId!).find((set) => set.name === f.ROOF_FOOTPRINT_PSET)?.properties.map((p) => p.name);
    expect(names?.sort()).toEqual(['EdgeSlopes', 'Footprint', 'Overhang', 'Thickness']);
  });

  it('the flat forms are unchanged: no footprint fields, no definition, one slab body', async () => {
    const s = await storey();
    const built = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3 });
    expect(built.solidIds).toBeUndefined();
    expect(f.readFootprintRoofInStore(s.store, built.roofId, s.view)).toBeNull();
    expect(roofRecord(exportText(s))).toMatch(/\.FLAT_ROOF\.\s*$/);
  });

  it('reports the planes\' sloped and plan areas as Qto_RoofBaseQuantities', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    const set = s.view.getQuantitiesForEntity(roofId).find((q) => q.name === 'Qto_RoofBaseQuantities');
    const values = Object.fromEntries(set?.quantities.map((q) => [q.name, q.value]) ?? []);
    expect(values.GrossArea).toBeCloseTo(80 / Math.cos(30 * D), 6);
    expect(values.NetArea).toBeCloseTo(80 / Math.cos(30 * D), 6);
    expect(values.ProjectedArea).toBeCloseTo(80, 6);
  });

  it('an edit changes one edge\'s slope and the overhang, rebuilding the planes in place', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    const placement = s.editor.getNewEntity(roofId)?.attributes[5];
    f.editFootprintRoofInStore(s.store, s.editor, roofId, { Edge: { Index: 1, Slope: 0 } });
    let definition = f.editFootprintRoofInStore(s.store, s.editor, roofId, { Edge: { Index: 3, Slope: 0 }, Overhang: 0.5 });
    expect(definition.PredefinedType).toBe('GABLE_ROOF');
    expect(definition.EdgeSlopes).toEqual([30 * D, 0, 30 * D, 0]);
    expect(f.readFootprintRoofInStore(s.store, roofId, s.view)).toEqual(definition);
    const text = exportText(s);
    expect(roofRecord(text)).toMatch(/\.GABLE_ROOF\.\s*$/);
    expect(s.editor.getNewEntity(roofId)?.attributes[5]).toBe(placement);
    // The replaced representation is gone, not orphaned: one product shape for one roof.
    expect(text.match(/IFCPRODUCTDEFINITIONSHAPE\(/g)).toHaveLength(1);
    definition = f.readFootprintRoofInStore(s.store, roofId, s.view)!;
    expect(definition.Overhang).toBe(0.5);
  });

  it('slab tools leave a roof by footprint to its own edit: their chain does not take its first plane', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    expect(resolveSlabEditChain(s.store, s.view, s.editor, roofId, 1)).toBeNull();
    const flat = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3 });
    expect(resolveSlabEditChain(s.store, s.view, s.editor, flat.roofId, 1)).not.toBeNull();
  });

  it('an edit leaves no orphaned planes behind: only the new ones are exported (#9356 review)', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    f.editFootprintRoofInStore(s.store, s.editor, roofId, { EdgeSlopes: [30 * D, 0, 30 * D, 0] });
    f.editFootprintRoofInStore(s.store, s.editor, roofId, { Overhang: 0.4 });
    const text = exportText(s);
    expect(text.match(/IFCEXTRUDEDAREASOLID\(/g)).toHaveLength(2);
    expect(text.match(/IFCSHAPEREPRESENTATION\('?#?\d*'?[^;]*'Body'/g)).toHaveLength(1);
  });

  it('an edit keeps a styled roof styled: each new plane takes the old planes\' style (#9356 review)', async () => {
    const s = await storey();
    const built = addRoofToStore(s.editor, s.anchor, HIP);
    expect(built.solidIds).toHaveLength(4);
    const style = s.editor.addEntity('IfcSurfaceStyle', ['Tiles', '.BOTH.', []]).expressId;
    for (const solid of built.solidIds ?? []) s.editor.addEntity('IfcStyledItem', [`#${solid}`, [`#${style}`], null]);
    f.editFootprintRoofInStore(s.store, s.editor, built.roofId, { EdgeSlopes: [30 * D, 0, 30 * D, 0] });
    const text = exportText(s);
    const solids = [...text.matchAll(/#(\d+)=IFCEXTRUDEDAREASOLID\(/g)].map((m) => m[1]);
    const styled = [...text.matchAll(/IFCSTYLEDITEM\(#(\d+),\(#(\d+)\)/g)].map((m) => [m[1], m[2]]);
    expect(solids).toHaveLength(2);
    expect(styled.map(([item]) => item).sort()).toEqual([...solids].sort());
    expect(new Set(styled.map(([, used]) => used)).size).toBe(1);
  });

  it('a closed outline with only an overhang counts one slope per edge (#9356 review)', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, {
      Profile: 'polygon', OuterCurve: [[0, 0], [6, 0], [6, 4], [0, 4], [0, 0]], Thickness: 0.2, Overhang: 0.3,
    });
    const definition = f.readFootprintRoofInStore(s.store, roofId, s.view)!;
    expect(definition.Footprint).toHaveLength(4);
    expect(definition.EdgeSlopes).toEqual([0, 0, 0, 0]);
    expect(definition.PredefinedType).toBe('FLAT_ROOF');
  });

  it.each([
    [{ Edge: null, Overhang: 1 }, /Edge must be/],
    [{ Edge: { Index: 1 } }, /Edge must be/],
    [{ EdgeSlopes: 0.5 }, /EdgeSlopes must be an array/],
    [{ Overhang: '1' }, /Overhang must be a length/],
  ])('refuses a malformed edit %j without writing (#9356 review)', async (patch, reason) => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    const journal = s.view.getMutations().length;
    expect(() => f.editFootprintRoofInStore(s.store, s.editor, roofId, patch as never)).toThrow(reason);
    expect(s.view.getMutations()).toHaveLength(journal);
  });

  it('a refused edit writes nothing', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, HIP);
    // Property sets written from the overlay take a fresh GlobalId on every export.
    const data = () => { const text = exportText(s); return text.slice(text.indexOf('DATA;')).replace(/'[0-9A-Za-z_$]{22}'/g, "'guid'"); };
    const before = data();
    expect(() => f.editFootprintRoofInStore(s.store, s.editor, roofId, { Edge: { Index: 0, Slope: 30 } })).toThrow(/slopes are radians/);
    expect(() => f.editFootprintRoofInStore(s.store, s.editor, roofId, { Edge: { Index: 7, Slope: 0 } })).toThrow(/Edge.Index/);
    expect(data()).toBe(before);
  });

  it('refuses to edit a roof that is not one by footprint', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, { Position: [0, 0, 0], Width: 6, Depth: 4, Thickness: 0.3 });
    expect(() => f.editFootprintRoofInStore(s.store, s.editor, roofId, { Overhang: 1 })).toThrow(/not a roof by footprint/);
  });

  it('refuses a footprint it cannot roof, before writing anything', async () => {
    const s = await storey();
    const before = s.view.getNewEntities().length;
    expect(() => s.editor.runAtomic((draft) => addRoofToStore(draft, s.anchor, {
      Profile: 'polygon', OuterCurve: [[0, 0], [10, 0], [10, 8], [5, 3], [0, 8]], Thickness: 0.2, EdgeSlopes: [0.5, 0.5, 0.5, 0.5, 0.5],
    }))).toThrow(/convex and rectilinear/);
    expect(s.view.getNewEntities()).toHaveLength(before);
  });

  it('a millimetre model gets its planes in millimetres', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, { ...s.anchor, lengthUnitScale: 0.001 }, HIP);
    const definition = f.readFootprintRoofInStore(s.store, roofId, s.view)!;
    // The definition stays in metres; only the emitted geometry is native.
    expect(definition.Footprint).toEqual([[0, 0], [10, 0], [10, 8], [0, 8]]);
    const depths = [...exportText(s).matchAll(/IFCEXTRUDEDAREASOLID\([^;]*,([\d.E+-]+)\);/g)].map((m) => Number(m[1]));
    expect(depths[0]).toBeCloseTo(250 / Math.cos(30 * D), 6);
  });
});

describe.skipIf(!existsSync(WASM_PATH))('roof by footprint against the mesh kernel', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  /** Z-up bounds and the upward faces (area by tilt) of every mesh of `expressId`. */
  function measure(text: string, expressId: number) {
    const bytes = new TextEncoder().encode(text);
    const pre = api.buildPrePassOnce(bytes);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    const tilts: Array<{ tilt: number; area: number }> = [];
    try {
      const collection = api.processGeometryBatch(bytes, pre.jobs, pre.unitScale, 0, 0, 0, false,
        pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors);
      try {
        for (let i = 0; i < collection.length; i++) {
          const mesh = collection.get(i);
          if (!mesh) continue;
          try {
            if (mesh.expressId !== expressId) continue;
            // Mesh positions are Y-up; IFC Z is mesh Y.
            const o = Array.from(mesh.origin), p = mesh.positions, idx = mesh.indices;
            const v = (k: number) => [p[3 * k] + o[0], p[3 * k + 1] + o[1], p[3 * k + 2] + o[2]];
            for (let k = 0; k < p.length / 3; k++) {
              const q = v(k);
              for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], q[axis]); max[axis] = Math.max(max[axis], q[axis]); }
            }
            for (let t = 0; t < idx.length; t += 3) {
              const a = v(idx[t]), b = v(idx[t + 1]), c = v(idx[t + 2]);
              const u = b.map((x, k) => x - a[k]), w = c.map((x, k) => x - a[k]);
              const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
              const length = Math.hypot(...n);
              if (n[1] > 1e-9 * length) tilts.push({ tilt: Math.acos(n[1] / length) / D, area: length / 2 });
            }
          } finally { mesh.free(); }
        }
      } finally { collection.free(); }
    } finally { api.clearPrePassCache(); }
    return { minZ: min[1], maxZ: max[1], tilts };
  }

  it.each([
    ['hip', [30, 30, 30, 30], 4 * Math.tan(30 * D), 30],
    ['gable', [30, 0, 30, 0], 4 * Math.tan(30 * D), 30],
    ['mono', [10, 0, 0, 0], 8 * Math.tan(10 * D), 10],
  ])('a %s roof meshes from its eaves up to its rise, every upward face at its slope', async (_name, degrees, rise, tilt) => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, { ...HIP, EdgeSlopes: degrees.map((a) => a * D) });
    const m = measure(exportText(s), roofId);
    expect(m.minZ).toBeCloseTo(3, 4);
    expect(m.maxZ - 3).toBeCloseTo(rise + 0.25 / Math.cos(tilt * D), 4);
    const upward = m.tilts.reduce((sum, f) => sum + f.area, 0);
    expect(upward).toBeCloseTo(80 / Math.cos(tilt * D), 3);
    expect(m.tilts.every((f) => Math.abs(f.tilt - tilt) < 1e-3)).toBe(true);
  });

  it('the FZK-Haus gable meshes with the reference\'s 165.12 m² of upward roof at 30°', async () => {
    const s = await storey();
    const { roofId } = addRoofToStore(s.editor, s.anchor, {
      Position: [0, 0, 2.7], Width: 12, Depth: 10, Thickness: 0.3, EdgeSlopes: [30 * D, 0, 30 * D, 0], Overhang: 0.5,
    });
    const m = measure(exportText(s), roofId);
    expect(m.tilts.reduce((sum, f) => sum + f.area, 0)).toBeCloseTo(165.12, 1);
    expect(m.minZ).toBeCloseTo(2.7 - 0.5 * Math.tan(30 * D), 4);
  });

  it('an L-shaped hip roof meshes watertight: its upward area is its planes\' sloped area', async () => {
    const s = await storey();
    const outline: Array<[number, number]> = [[0, 0], [10, 0], [10, 4], [6, 4], [6, 10], [0, 10]];
    const { roofId } = addRoofToStore(s.editor, s.anchor, { Profile: 'polygon', OuterCurve: outline, Thickness: 0.2, EdgeSlopes: outline.map(() => 35 * D) });
    const m = measure(exportText(s), roofId);
    expect(m.tilts.reduce((sum, f) => sum + f.area, 0)).toBeCloseTo(76 / Math.cos(35 * D), 3);
    expect(m.maxZ).toBeCloseTo(3 * Math.tan(35 * D) + 0.2 / Math.cos(35 * D), 4);
  });
});
