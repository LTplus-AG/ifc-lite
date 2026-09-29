/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * End to end for wall joins (#6232 D1): author two walls on a fresh storey
 * through the mutation overlay, join them with `applyWallJoinToStore`, export
 * with `StepExporter`, re-parse, and mesh through the real wasm geometry
 * pipeline.
 *
 * The oracle samples a grid of points around the joint at mid-height and asks
 * each wall MESH whether the point is inside it (ray parity). No point may be
 * inside both meshes (no overlapping volume), and each mesh must hold exactly
 * the points of the body quad the join computed (the file carries the join; the
 * quads themselves are checked against the ideal footprint in
 * `wall-join.test.ts`). The unjoined pair is run through the same oracle to show
 * it does catch the overlap.
 *
 * The wasm half skips (never fails) when `packages/wasm/pkg/ifc-lite_bg.wasm`
 * is not built on this host — see `pnpm build:wasm:fetch`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { RelationshipType } from '@ifc-lite/data';
import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import { IfcAPI, initSync } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import { addWallToStore, type WallInStoreParams } from './wall.js';
import { applyWallJoinToStore, wallJoinTargetFromBuild } from './wall-join-apply.js';
import { wallBodyOutline, type PlanPoint, type WallJoin, type WallJoinWall } from './wall-join.js';

const WASM_PATH = fileURLToPath(new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url));
const WASM_AVAILABLE = existsSync(WASM_PATH);
const HEIGHT = 3;

type Vec3 = [number, number, number];
interface Mesh { positions: Float64Array; indices: Uint32Array }

async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

interface Authored { text: string; wallIds: [number, number]; join: WallJoin | null }

/** A fresh storey with walls `a` and `b` on it, joined unless `join` is false. */
async function author(schema: 'IFC2X3' | 'IFC4' | 'IFC4X3', a: WallInStoreParams, b: WallInStoreParams, join = true): Promise<Authored> {
  const creator = new IfcCreator({ Name: 'Wall joins', Schema: schema });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const store = await parse(creator.toIfc().content);
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const ta = wallJoinTargetFromBuild(addWallToStore(editor, anchor, a), a);
  const tb = wallJoinTargetFromBuild(addWallToStore(editor, anchor, b), b);
  const result = join ? applyWallJoinToStore(editor, anchor, ta, tb) : null;
  const exported = new StepExporter(store, view).export({ schema, applyMutations: true });
  return { text: new TextDecoder().decode(exported.content), wallIds: [ta.wallId, tb.wallId], join: result?.join ?? null };
}

function meshWalls(api: IfcAPI, text: string): Map<number, Mesh[]> {
  const bytes = new TextEncoder().encode(text);
  const pre = api.buildPrePassOnce(bytes);
  const meshes = new Map<number, Mesh[]>();
  try {
    // No RTC shift: the walls sit near the origin, so mesh coordinates are world coordinates.
    const collection = api.processGeometryBatch(
      bytes, pre.jobs, pre.unitScale, 0, 0, 0, false,
      pre.voidKeys, pre.voidCounts, pre.voidValues, pre.styleIds, pre.styleColors,
    );
    try {
      for (let i = 0; i < collection.length; i++) {
        const m = collection.get(i);
        if (!m) continue;
        if (m.ifcType === 'IfcWall') {
          const list = meshes.get(m.expressId) ?? [];
          // Positions are relative to the mesh's own origin (WebGL Y-up); make them absolute.
          const [ox, oy, oz] = Array.from(m.origin);
          const positions = Float64Array.from(m.positions);
          for (let k = 0; k < positions.length; k += 3) {
            positions[k] += ox;
            positions[k + 1] += oy;
            positions[k + 2] += oz;
          }
          list.push({ positions, indices: m.indices.slice() });
          meshes.set(m.expressId, list);
        }
        m.free();
      }
    } finally {
      collection.free();
    }
  } finally {
    api.clearPrePassCache();
  }
  return meshes;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// An irregular direction so the ray does not graze edges or run along faces.
const RAY: Vec3 = (() => {
  const d: Vec3 = [0.8123, 0.1371, 0.5669];
  const l = Math.hypot(...d);
  return [d[0] / l, d[1] / l, d[2] / l];
})();

/** Ray parity (Möller–Trumbore): is `origin` inside the closed mesh? */
function insideMesh(meshes: Mesh[], origin: Vec3): boolean {
  let hits = 0;
  for (const { positions: p, indices } of meshes) {
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i] * 3, indices[i + 1] * 3, indices[i + 2] * 3];
      const e1: Vec3 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
      const e2: Vec3 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
      const h = cross(RAY, e2);
      const det = dot(e1, h);
      if (Math.abs(det) < 1e-12) continue;
      const s: Vec3 = [origin[0] - p[a], origin[1] - p[a + 1], origin[2] - p[a + 2]];
      const u = dot(s, h) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1);
      const v = dot(RAY, q) / det;
      if (v < 0 || u + v > 1) continue;
      if (dot(e2, q) / det > 1e-9) hits++;
    }
  }
  return hits % 2 === 1;
}

function bodyQuad(wall: WallJoinWall): PlanPoint[] {
  const { corners, length } = wallBodyOutline(wall);
  const d: PlanPoint = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
  return corners.map(([x, y]) => [wall.start[0] + x * d[0] - y * d[1], wall.start[1] + x * d[1] + y * d[0]]);
}

function inConvex(quad: PlanPoint[], p: PlanPoint): boolean {
  return quad.every((a, i) => {
    const b = quad[(i + 1) % quad.length];
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  });
}

interface Tally { both: number; mismatches: string[]; inside: number }

/** Sample a grid around `centre` at mid-height; meshes are Y-up, so IFC (x, y, z) is (x, z, -y). */
function sample(meshA: Mesh[], meshB: Mesh[], centre: PlanPoint, quads?: [PlanPoint[], PlanPoint[]]): Tally {
  const tally: Tally = { both: 0, mismatches: [], inside: 0 };
  const step = 0.0231;
  for (let dx = -0.8 + 0.00731; dx < 0.8; dx += step) {
    for (let dy = -0.8 + 0.00419; dy < 0.8; dy += step) {
      const p: PlanPoint = [centre[0] + dx, centre[1] + dy];
      const origin: Vec3 = [p[0], HEIGHT / 2, -p[1]];
      const inA = insideMesh(meshA, origin);
      const inB = insideMesh(meshB, origin);
      if (inA && inB) tally.both++;
      if (inA || inB) tally.inside++;
      if (quads && (inA !== inConvex(quads[0], p) || inB !== inConvex(quads[1], p)) && tally.mismatches.length < 5) {
        tally.mismatches.push(`(${p[0].toFixed(3)}, ${p[1].toFixed(3)}): mesh ${+inA}${+inB}, quads ${+inConvex(quads[0], p)}${+inConvex(quads[1], p)}`);
      }
    }
  }
  return tally;
}

const DEG = Math.PI / 180;
const at = (angle: number, length: number, from: PlanPoint = [0, 0]): [number, number, number] =>
  [from[0] + Math.cos(angle * DEG) * length, from[1] + Math.sin(angle * DEG) * length, 0];

const CASES: Array<{ name: string; a: WallInStoreParams; b: WallInStoreParams; kind: WallJoin['kind'] }> = [
  {
    name: 'L at 90 degrees',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.2, Height: HEIGHT },
    b: { Start: [0, 0, 0], End: [0, 4, 0], Thickness: 0.2, Height: HEIGHT },
    kind: 'L',
  },
  {
    name: 'L at 60 degrees, thickness mismatch, left-aligned',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.3, Height: HEIGHT, Alignment: 'left' },
    b: { Start: [0, 0, 0], End: at(120, 4), Thickness: 0.15, Height: HEIGHT },
    kind: 'L',
  },
  {
    name: 'T at 50 degrees, offset body',
    a: { Start: at(50, 4, [0.4, 0]), End: [0.4, 0.2, 0], Thickness: 0.2, Height: HEIGHT, Offset: 0.03 },
    b: { Start: [-4, 0, 0], End: [4, 0, 0], Thickness: 0.3, Height: HEIGHT },
    kind: 'T',
  },
  {
    name: 'butt in line, thickness mismatch',
    a: { Start: [-4, 0, 0], End: [0, 0, 0], Thickness: 0.3, Height: HEIGHT },
    b: { Start: [0, 0, 0], End: [4, 0, 0], Thickness: 0.2, Height: HEIGHT, Alignment: 'right' },
    kind: 'butt',
  },
];

describe.skipIf(!WASM_AVAILABLE)('wall join -> StepExporter -> wasm mesh (#6232)', () => {
  let api: IfcAPI;
  beforeAll(() => {
    initSync({ module: readFileSync(WASM_PATH) });
    api = new IfcAPI();
  });

  it('the oracle sees the overlap of two unjoined walls drawn to the corner', async () => {
    const { a, b } = CASES[0];
    const { text, wallIds } = await author('IFC4', { ...a, End: [0.1, 0, 0] }, b, false);
    const meshes = meshWalls(api, text);
    const tally = sample(meshes.get(wallIds[0]) ?? [], meshes.get(wallIds[1]) ?? [], [0, 0]);
    expect(tally.inside).toBeGreaterThan(100);
    expect(tally.both).toBeGreaterThan(0);
  });

  for (const c of CASES) {
    it(`${c.name}: meshes with no overlapping volume, exactly the joined bodies`, async () => {
      const { text, wallIds, join } = await author('IFC4', c.a, c.b);
      expect(join?.kind).toBe(c.kind);
      const meshes = meshWalls(api, text);
      const meshA = meshes.get(wallIds[0]) ?? [];
      const meshB = meshes.get(wallIds[1]) ?? [];
      expect(meshA.length).toBeGreaterThan(0);
      expect(meshB.length).toBeGreaterThan(0);
      const tally = sample(meshA, meshB, join!.point, [bodyQuad(join!.a.wall), bodyQuad(join!.b.wall)]);
      expect(tally.inside).toBeGreaterThan(100);
      expect(tally.both).toBe(0);
      expect(tally.mismatches).toEqual([]);
    });
  }
});

describe('wall join -> StepExporter -> re-parse (#6232)', () => {
  it.each(['IFC2X3', 'IFC4', 'IFC4X3'] as const)('%s: the connects relationship and axis round-trip', async (schema) => {
    const { a, b } = CASES[1];
    const { text, wallIds } = await author(schema, a, b);
    const store = await parse(text);
    const rels = store.entityIndex.byType.get('IFCRELCONNECTSPATHELEMENTS') ?? [];
    expect(rels).toHaveLength(1);
    // The thicker wall a runs through: it relates, at its end; b is related at its start.
    expect(store.relationships.getRelated(wallIds[0], RelationshipType.ConnectsPathElements, 'forward')).toEqual([wallIds[1]]);
    expect(store.relationships.getRelated(wallIds[1], RelationshipType.ConnectsPathElements, 'inverse')).toEqual([wallIds[0]]);
    expect(text).toMatch(new RegExp(`IFCRELCONNECTSPATHELEMENTS\\('.{22}',(#\\d+|\\$),\\$,\\$,\\$,#${wallIds[0]},#${wallIds[1]},\\(\\),\\(\\),\\.ATSTART\\.,\\.ATEND\\.\\);`));
    expect(text).toMatch(/IFCSHAPEREPRESENTATION\(#\d+,'Axis','Curve2D',\(#\d+\)\);/);
    expect(store.entityIndex.byType.get('IFCARBITRARYCLOSEDPROFILEDEF')?.length).toBe(2);
  });
});
