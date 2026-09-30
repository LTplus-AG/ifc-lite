/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Test oracle shared by the wall-join end-to-end tests (#6232): mesh a STEP
 * text through the wasm pipeline and ask each wall MESH, by ray parity,
 * whether sampled points are inside it. See `wall-join.e2e.test.ts`.
 */

import { IfcParser, extractPropertiesOnDemand, type IfcDataStore } from '@ifc-lite/parser';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { StepExporter } from '@ifc-lite/export';
import type { IfcAPI } from '@ifc-lite/wasm';
import { IfcCreator } from '../ifc-creator.js';
import { resolveSpatialAnchor } from './resolve-anchor.js';
import type { JoinAnchor } from './wall-join-apply.js';
import { resolveWallJoinAnchor } from './wall-join-edit.js';
import { wallBodyOutline, type PlanPoint, type WallJoinWall } from './wall-join.js';

export const HEIGHT = 3;

export type Vec3 = [number, number, number];
export interface Mesh { positions: Float64Array; indices: Uint32Array }

export async function parse(text: string): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(new TextEncoder().encode(text).buffer as ArrayBuffer, { disableWorkerScan: true });
}

export type Schema = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** A fresh storey to author walls on through the mutation overlay. */
export async function newStorey(schema: Schema = 'IFC4') {
  const creator = new IfcCreator({ Name: 'Wall joins', Schema: schema });
  const storeyId = creator.addIfcBuildingStorey({ Name: 'GF', Elevation: 0 });
  const store = await parse(creator.toIfc().content);
  const view = new MutablePropertyView(null, 'm');
  view.setOnDemandExtractor((id: number) => extractPropertiesOnDemand(store, id));
  const editor = new StoreEditor(store, view);
  const anchor = resolveSpatialAnchor(store, storeyId, view);
  const joinAnchor: JoinAnchor = resolveWallJoinAnchor(store, view);
  return { store, view, editor, anchor, joinAnchor, storeyId, schema };
}

/** The storey's model as STEP text, edits applied. */
export function exportText(s: { store: IfcDataStore; view: MutablePropertyView; schema: Schema }): string {
  return new TextDecoder().decode(new StepExporter(s.store, s.view).export({ schema: s.schema, applyMutations: true }).content);
}

export function meshWalls(api: IfcAPI, text: string): Map<number, Mesh[]> {
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
export function insideMesh(meshes: Mesh[], origin: Vec3): boolean {
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

export function bodyQuad(wall: WallJoinWall): PlanPoint[] {
  const { corners, length } = wallBodyOutline(wall);
  const d: PlanPoint = [(wall.end[0] - wall.start[0]) / length, (wall.end[1] - wall.start[1]) / length];
  return corners.map(([x, y]) => [wall.start[0] + x * d[0] - y * d[1], wall.start[1] + x * d[1] + y * d[0]]);
}

export function inConvex(quad: PlanPoint[], p: PlanPoint): boolean {
  return quad.every((a, i) => {
    const b = quad[(i + 1) % quad.length];
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
  });
}

export interface Tally { both: number; mismatches: string[]; inside: number }

/** Sample a grid around `centre` at mid-height; meshes are Y-up, so IFC (x, y, z) is (x, z, -y). */
export function sample(meshA: Mesh[], meshB: Mesh[], centre: PlanPoint, quads?: [PlanPoint[], PlanPoint[]]): Tally {
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

