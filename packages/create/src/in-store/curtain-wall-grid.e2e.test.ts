/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Round trip of the in-store curtain wall and grid builders (#6232 B5).
 * Elements are authored through the mutation overlay into a parsed model (the
 * viewer's path), exported with `StepExporter`, re-parsed, and meshed with the
 * real wasm geometry pipeline: classes and relationships must survive the
 * trip, every panel and member must mesh with the expected bounding box and
 * volume (integrated from the triangles), and a column placed on a grid
 * intersection must land on it. The curtain wall is also compared with
 * IfcCreator's single-body curtain wall over the same base line.
 *
 * Skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm` is not built
 * on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addCurtainWallToStore, type CurtainWallBuildResult } from './curtain-wall.js';
import { addGridToStore, gridIntersectionPlacement, rectangularGridAxes } from './grid.js';
import { addColumnToStore } from './column.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);

type Vec3 = [number, number, number];
interface Box { min: Vec3; max: Vec3 }
interface Meshed { ifcType: string; box: Box; volume: number }

/** Mesh a file; per expressId: IFC type, bounding box in IFC axes (Z up), volume. */
function mesh(api: IfcAPI, content: string): Map<number, Meshed> {
  const bytes = new TextEncoder().encode(content);
  const pre = api.buildPrePassOnce(bytes);
  const out = new Map<number, Meshed>();
  try {
    const [x, y, z] = pre.rtcOffset ? Array.from(pre.rtcOffset as ArrayLike<number>) : [0, 0, 0];
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, x, y, z, pre.needsShift,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (!m) continue;
        const entry = out.get(m.expressId) ?? {
          ifcType: m.ifcType,
          box: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } as Box,
          volume: 0,
        };
        // Meshes are WebGL Y-up, relative to a per-mesh origin:
        // IFC (x, y, z) -> (x, z, -y).
        const p = m.positions;
        const o = m.origin;
        for (let k = 0; k < p.length; k += 3) {
          const ifc: Vec3 = [o[0] + p[k], -(o[2] + p[k + 2]), o[1] + p[k + 1]];
          for (let a = 0; a < 3; a++) {
            entry.box.min[a] = Math.min(entry.box.min[a], ifc[a]);
            entry.box.max[a] = Math.max(entry.box.max[a], ifc[a]);
          }
        }
        // Enclosed volume by the divergence theorem (closed, outward-wound mesh).
        const t = m.indices;
        for (let k = 0; k < t.length; k += 3) {
          const [a, b, c] = [t[k] * 3, t[k + 1] * 3, t[k + 2] * 3];
          entry.volume += (
            p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
            - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
            + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
          ) / 6;
        }
        out.set(m.expressId, entry);
        m.free();
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return out;
}

/** The STEP record of entity #id. */
function record(text: string, id: number): string {
  const match = new RegExp(`^#${id}=([A-Z0-9]+\\(.*\\));$`, 'm').exec(text);
  if (!match) throw new Error(`no #${id}`);
  return match[1];
}

function expectBoxClose(actual: Box, expected: Box, digits = 4): void {
  for (let k = 0; k < 3; k++) {
    expect(actual.min[k]).toBeCloseTo(expected.min[k], digits);
    expect(actual.max[k]).toBeCloseTo(expected.max[k], digits);
  }
}

function union(boxes: Box[]): Box {
  const out: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of boxes) {
    for (let k = 0; k < 3; k++) {
      out.min[k] = Math.min(out.min[k], b.min[k]);
      out.max[k] = Math.max(out.max[k], b.max[k]);
    }
  }
  return out;
}

/** An editor on a parsed IfcCreator model with one storey, plus its export. */
async function authoring(schema: 'IFC4' | 'IFC4X3') {
  const base = new IfcCreator({ Name: 'B5', Schema: schema });
  const storeyId = base.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const bytes = new TextEncoder().encode(base.toIfc().content);
  const store = await new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'b5');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const exportText = () => new TextDecoder().decode(new StepExporter(store, view).export({ schema, applyMutations: true }).content);
  return { editor, anchor, exportText };
}

async function reparse(text: string) {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

// 3 m x 2.5 m on a base line along +Y at 0.5 m: three 1 m bays, rows split at 0.9 m.
// Default 50 x 150 mm members, 24 mm panels.
const CW = { Start: [1, 2, 0.5] as Vec3, End: [1, 5, 0.5] as Vec3, Height: 2.5, UGrid: 3, VGrid: [0.9], Name: 'CW' };

describe.skipIf(!WASM_AVAILABLE)('in-store curtain wall and grid round trip (#6232 B5)', () => {
  let api: IfcAPI;
  let text: string;
  let cw: CurtainWallBuildResult;
  let meshes: Map<number, Meshed>;

  beforeAll(async () => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
    const a = await authoring('IFC4');
    cw = addCurtainWallToStore(a.editor, a.anchor, CW);
    text = a.exportText();
    meshes = mesh(api, text);
  });

  it('re-parses the curtain wall with its members and panels aggregated under it', async () => {
    const store = await reparse(text);
    const count = (type: string) => (store.entityIndex.byType.get(type) ?? []).length;
    expect(count('IFCCURTAINWALL')).toBe(1);
    expect(count('IFCMEMBER')).toBe(4 + 9);
    expect(count('IFCPLATE')).toBe(6);
    const parts = [...cw.mullionIds, ...cw.transomIds, ...cw.panelIds];
    expect(text).toMatch(new RegExp(
      `IFCRELAGGREGATES\\('.{22}',[^,]*,\\$,\\$,#${cw.curtainWallId},\\(${parts.map((id) => `#${id}`).join(',')}\\)\\)`,
    ));
    expect(text).toMatch(new RegExp(`IFCRELCONTAINEDINSPATIALSTRUCTURE\\('.{22}',[^,]*,\\$,\\$,\\(#${cw.curtainWallId}\\),#\\d+\\)`));
    expect(record(text, cw.curtainWallId)).toMatch(/^IFCCURTAINWALL\('.{22}',#\d+,'CW',\$,\$,#\d+,\$,\$,\.NOTDEFINED\.\)$/);
    expect(record(text, cw.mullionIds[0])).toMatch(/,\.MULLION\.\)$/);
    expect(record(text, cw.panelIds[0])).toMatch(/,\.CURTAIN_PANEL\.\)$/);
    // The parser resolves the decomposition: the curtain wall's parts.
    const children = store.relationships.getRelated(cw.curtainWallId, RelationshipType.Aggregates, 'forward');
    expect([...children].sort((x, y) => x - y)).toEqual([...parts].sort((x, y) => x - y));
    for (const id of parts) {
      expect(store.relationships.getRelated(id, RelationshipType.Aggregates, 'inverse')).toEqual([cw.curtainWallId]);
    }
  });

  it('meshes every member and panel where the layout puts it, with its volume', () => {
    // Local u runs along +Y from y = 2, local v up from z = 0.5, depth across X.
    const mullion = meshes.get(cw.mullionIds[1])!;
    expect(mullion.ifcType).toBe('IfcMember');
    expectBoxClose(mullion.box, { min: [0.925, 2.975, 0.5], max: [1.075, 3.025, 3.0] });
    expect(mullion.volume).toBeCloseTo(0.05 * 0.15 * 2.5, 6);

    // Middle row of the first bay: between the edge mullion and mullion 2.
    const transom = meshes.get(cw.transomIds[1])!;
    expectBoxClose(transom.box, { min: [0.925, 2.05, 1.375], max: [1.075, 2.975, 1.425] });
    expect(transom.volume).toBeCloseTo(0.05 * 0.15 * 0.925, 6);

    const panel = meshes.get(cw.panelIds[0])!;
    expect(panel.ifcType).toBe('IfcPlate');
    expectBoxClose(panel.box, { min: [0.988, 2.05, 0.55], max: [1.012, 2.975, 1.375] });
    expect(panel.volume).toBeCloseTo(0.925 * 0.825 * 0.024, 6);

    // Totals from the outline: panels fill 2.8 m x 2.35 m of clear openings,
    // the members the rest of the 3 m x 2.5 m face, 150 mm deep.
    const sum = (ids: number[]) => ids.reduce((acc, id) => acc + meshes.get(id)!.volume, 0);
    expect(sum(cw.panelIds)).toBeCloseTo(2.8 * 2.35 * 0.024, 6);
    expect(sum([...cw.mullionIds, ...cw.transomIds])).toBeCloseTo((3 * 2.5 - 2.8 * 2.35) * 0.15, 6);
    // The curtain wall itself carries no body; its parts do.
    expect(meshes.has(cw.curtainWallId)).toBe(false);
  });

  it('covers the same box as IfcCreator\'s single-body curtain wall of the member depth', () => {
    const c = new IfcCreator({ Name: 'Parity' });
    const s = c.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
    const theirsId = c.addIfcCurtainWall(s, { Start: CW.Start, End: CW.End, Height: CW.Height, Thickness: 0.15, Name: 'CW' });
    const theirs = mesh(api, c.toIfc().content).get(theirsId)!;
    expect(theirs.ifcType).toBe('IfcCurtainWall');
    const ours = union([...cw.mullionIds, ...cw.transomIds, ...cw.panelIds].map((id) => meshes.get(id)!.box));
    expectBoxClose(ours, theirs.box);
    expectBoxClose(ours, { min: [0.925, 2, 0.5], max: [1.075, 5, 3] });
  });

  it('IFC4X3: a grid on the storey and a column on a grid intersection', async () => {
    const a = await authoring('IFC4X3');
    // Grid at (2, 3), turned 90°: grid X runs along storey +Y, grid Y along -X.
    const grid = addGridToStore(a.editor, a.anchor, {
      Position: [2, 3, 0],
      Direction: Math.PI / 2,
      ...rectangularGridAxes({ UOffsets: [0, 6], VOffsets: [0, 4, 8] }),
      PredefinedType: 'RECTANGULAR',
      Name: 'Grid',
    });
    // A 0.4 x 0.2 column on 2/C (grid (6, 8)), 0.5 m up, oriented by the grid.
    const column = addColumnToStore(a.editor, a.anchor, { Position: [0, 0, 0], Width: 0.4, Depth: 0.2, Height: 3, Name: 'C-2C' });
    const place = gridIntersectionPlacement(a.editor, a.anchor, {
      Axes: [grid.uAxisIds[1], grid.vAxisIds[2]], Offsets: [0, 0, 0.5], GridPlacementId: grid.placementId,
    });
    a.editor.setPositionalAttribute(column.columnId, 5, `#${place.placementId}`);
    const out = a.exportText();

    const store = await reparse(out);
    const count = (type: string) => (store.entityIndex.byType.get(type) ?? []).length;
    expect(count('IFCGRID')).toBe(1);
    expect(count('IFCGRIDAXIS')).toBe(5);
    expect(count('IFCGRIDPLACEMENT')).toBe(1);
    expect(count('IFCVIRTUALGRIDINTERSECTION')).toBe(1);
    const tags = grid.uAxisIds.concat(grid.vAxisIds).map((id) => /^IFCGRIDAXIS\('([^']*)'/.exec(record(out, id))![1]);
    expect(tags).toEqual(['1', '2', 'A', 'B', 'C']);
    expect(record(out, grid.gridId)).toMatch(new RegExp(
      `,\\(#${grid.uAxisIds.join(',#')}\\),\\(#${grid.vAxisIds.join(',#')}\\),\\$,\\.RECTANGULAR\\.\\)$`,
    ));
    expect(out).toMatch(new RegExp(`IFCRELCONTAINEDINSPATIALSTRUCTURE\\('.{22}',[^,]*,\\$,\\$,\\(#${grid.gridId}\\),#\\d+\\)`));
    expect(record(out, place.placementId)).toBe(`IFCGRIDPLACEMENT(#${grid.placementId},#${place.intersectionId},$)`);
    expect(record(out, column.columnId)).toContain(`,#${place.placementId},`);

    const meshed = mesh(api, out);
    // The grid is lines, not a body: no mesh, but the viewer's grid-axis
    // extraction resolves all five tagged axes through the grid's placement.
    expect(meshed.has(grid.gridId)).toBe(false);
    const axes = api.parseGridAxes(out);
    try {
      const byTag = new Map<string, { gridId: number; start: number[]; end: number[] }>();
      for (let i = 0; i < axes.length; i++) {
        const axis = axes.getAxis(i)!;
        byTag.set(axis.tag, { gridId: axis.gridId, start: Array.from(axis.start), end: Array.from(axis.end) });
        axis.free();
      }
      expect([...byTag.keys()].sort()).toEqual(['1', '2', 'A', 'B', 'C']);
      // Axis 2 runs grid (6, -1) -> (6, 9), i.e. storey (3, 9) -> (-7, 9); renderer Y-up is (x, z, -y).
      const two = byTag.get('2')!;
      expect(two.gridId).toBe(grid.gridId);
      two.start.forEach((v, k) => expect(v).toBeCloseTo([3, 0, -9][k], 4));
      two.end.forEach((v, k) => expect(v).toBeCloseTo([-7, 0, -9][k], 4));
    } finally {
      axes.free();
    }
    // Grid (6, 8) -> storey (2 - 8, 3 + 6) = (-6, 9); the section's X (0.4) turns onto storey Y.
    const col = meshed.get(column.columnId)!;
    expect(col.ifcType).toBe('IfcColumn');
    expectBoxClose(col.box, { min: [-6.1, 8.8, 0.5], max: [-5.9, 9.2, 3.5] });
    expect(col.volume).toBeCloseTo(0.4 * 0.2 * 3, 6);
  });
});
