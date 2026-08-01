#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.5 measurement side. ONE function computes the headline quantities of a
 * room, and it is run over the kernel's meshes -- so the reference model and
 * the scan-derived model are measured by identical code on identical
 * representations (triangles out of `processGeometryBatch`), never by reading
 * one model's stored quantities against the other's computed ones.
 *
 * Usage: node measure-ifc.mjs <file.ifc> [--json out.json] [--redact]
 *   --redact  omit every string carried from the source file (names, GUIDs);
 *             required for anything written into the repo, because the
 *             reference model is client data.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSync, IfcAPI } from '../../../packages/wasm/pkg/ifc-lite.js';
import { parseMeshesViaPrePass } from '../../lib/mesh-via-prepass.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../../..');

let api = null;
export function getApi() {
  if (!api) {
    initSync(readFileSync(join(ROOT, 'packages/wasm/pkg/ifc-lite_bg.wasm')));
    api = new IfcAPI();
  }
  return api;
}

/** World-space triangle iterator over a mesh from `parseMeshesViaPrePass`. */
function* triangles(mesh) {
  const p = mesh.positions;
  const idx = mesh.indices;
  const [ox, oy, oz] = mesh.origin ?? [0, 0, 0];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    yield [
      [p[a] + ox, p[a + 1] + oy, p[a + 2] + oz],
      [p[b] + ox, p[b + 1] + oy, p[b + 2] + oz],
      [p[c] + ox, p[c + 1] + oy, p[c + 2] + oz],
    ];
  }
}

/**
 * Headline quantities of one closed solid.
 *
 *  volume        divergence theorem over the triangle soup (|sum v0.(v1 x v2)|/6)
 *  floorArea     sum of the XY-projected area of DOWNWARD-facing triangles.
 *                For a closed solid the signed XY projection sums to zero, so
 *                this equals the upward-facing sum and is the footprint of any
 *                vertically monotone room. Not "area of the bottom face", which
 *                would be wrong the moment the floor is triangulated across a
 *                step.
 *  lateralArea   true (un-projected) area of triangles whose normal is within
 *                VERT_TOL of horizontal -- the room's bounding wall surface.
 *  height        z extent.
 */
const VERT_TOL = 0.05;   // |n_up| below this counts as a vertical (wall) face
const HORIZ_TOL = 0.95;  // |n_up| above this counts as a horizontal face

/**
 * UP AXIS. `processGeometryBatch` emits VIEWER-frame meshes (three.js Y-up),
 * not IFC Z-up: on the reference model every wall's extent on axis 1 is
 * exactly the two IfcBuildingStorey elevations, and the plan spreads over
 * axes 0 and 2. Measuring "floor area" off axis 2 therefore returns 0, which
 * is what the first run of this script did. Both models go through the same
 * conversion, so this constant is a property of the kernel boundary, not a
 * per-model fudge.
 */
const UP = 1;

export function solidQuantities(meshes) {
  let vol6 = 0, floorArea = 0, ceilArea = 0, lateralArea = 0;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let triCount = 0;
  for (const mesh of meshes) {
    for (const [v0, v1, v2] of triangles(mesh)) {
      triCount++;
      // cross(v1-v0, v2-v0)
      const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
      const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];
      const n = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
      const nz = n[UP];
      const twiceArea = Math.hypot(n[0], n[1], n[2]);
      if (twiceArea === 0) continue;
      vol6 += v0[0] * (v1[1] * v2[2] - v1[2] * v2[1])
            - v0[1] * (v1[0] * v2[2] - v1[2] * v2[0])
            + v0[2] * (v1[0] * v2[1] - v1[1] * v2[0]);
      const unitZ = nz / twiceArea;
      const projected = nz / 2; // signed XY-projected area
      if (unitZ < -HORIZ_TOL) floorArea += -projected;
      else if (unitZ > HORIZ_TOL) ceilArea += projected;
      if (Math.abs(unitZ) < VERT_TOL) lateralArea += twiceArea / 2;
      for (const v of [v0, v1, v2]) {
        if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
        if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
        if (v[2] < minZ) minZ = v[2]; if (v[2] > maxZ) maxZ = v[2];
      }
    }
  }
  const bmin = [minX, minY, minZ];
  const bmax = [maxX, maxY, maxZ];
  const height = bmax[UP] - bmin[UP];
  return {
    volume: Math.abs(vol6) / 6,
    floorArea,
    ceilingArea: ceilArea,
    lateralArea,
    height,
    perimeter: height > 1e-6 ? lateralArea / height : 0,
    bbox: { min: bmin, max: bmax },
    triangleCount: triCount,
  };
}

export function meshModel(path) {
  const content = readFileSync(path, 'utf8');
  const col = parseMeshesViaPrePass(getApi(), content);
  const byId = new Map();
  for (let i = 0; i < col.length; i++) {
    const m = col.get(i);
    if (!m) continue;
    if (!byId.has(m.expressId)) byId.set(m.expressId, { ifcType: m.ifcType, meshes: [] });
    byId.get(m.expressId).meshes.push(m);
  }
  return { byId, content };
}

/** Pull `#id=IFCSPACE(...)` LongName without a full parse (attribute 8). */
function spaceLabels(content) {
  const out = new Map();
  for (const m of content.matchAll(/#(\d+)\s*=\s*IFCSPACE\s*\(([^]*?)\);/g)) {
    const args = splitStepArgs(m[2]);
    out.set(Number(m[1]), {
      name: unquote(args[2]),
      longName: unquote(args[7]),
    });
  }
  return out;
}
function splitStepArgs(s) {
  const out = []; let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) { cur += ch; if (ch === "'") inStr = (s[i + 1] === "'"); continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function unquote(v) {
  if (!v || v === '$') return null;
  const m = /^'([^]*)'$/.exec(v);
  return m ? m[1].replace(/''/g, "'") : v;
}

export function measureSpaces(path) {
  const { byId, content } = meshModel(path);
  const labels = spaceLabels(content);
  const spaces = [];
  for (const [id, rec] of byId) {
    if (rec.ifcType.toUpperCase() !== 'IFCSPACE') continue;
    const q = solidQuantities(rec.meshes);
    spaces.push({ expressId: id, ...labels.get(id), ...q });
  }
  spaces.sort((a, b) => b.floorArea - a.floorArea);
  const walls = [];
  for (const [id, rec] of byId) {
    if (!/WALL/i.test(rec.ifcType)) continue;
    walls.push({ expressId: id, ifcType: rec.ifcType, ...solidQuantities(rec.meshes) });
  }
  const typeCounts = {};
  for (const rec of byId.values()) typeCounts[rec.ifcType] = (typeCounts[rec.ifcType] ?? 0) + 1;
  return { spaces, walls, typeCounts };
}

if (process.argv[1] && process.argv[1].endsWith('measure-ifc.mjs')) {
  const file = process.argv[2];
  const redact = process.argv.includes('--redact');
  const jsonAt = process.argv.indexOf('--json');
  const result = measureSpaces(file);
  if (redact) {
    for (const s of result.spaces) { delete s.name; delete s.longName; }
  }
  const text = JSON.stringify(result, null, 2);
  if (jsonAt >= 0) writeFileSync(process.argv[jsonAt + 1], text);
  else console.log(text);
}
